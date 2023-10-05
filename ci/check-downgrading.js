const { join, posix, sep } = require('path');
const {
  readFileSync,
  existsSync
} = require('fs');
const { mkdir, rm } = require('shelljs');
const { platform } = require('os');
const { run, resolveTaskList, logToPipeline } = require('./ci-util');
const { eq, inc, parse, lte, neq } = require('semver');

const taskVersionBumpingDocUrl = "https://aka.ms/azp-tasks-version-bumping";

const packageEndpoint = process.env['PACKAGE_VERSIONS_ENDPOINT'];

if (!packageEndpoint) {
  logToPipeline('error', 'Failed to get info from package endpoint because no endpoint was specified. Try setting the PACKAGE_VERSIONS_ENDPOINT environment variable.')
  process.exit(1);
}

const { RestClient } = require('typed-rest-client/RestClient');
const client = new RestClient('azure-pipelines-tasks-ci', '');

const argv = require('minimist')(process.argv.slice(2));

if (!argv.task) {
  console.log(`$(task_pattern) variable is empty or not set. Aborting...`);
  process.exit(0);
};

// We need to escape # on Unix platforms since that turns the rest of the string into a comment
const escapeHash = str => platform() == 'win32' ? str : str.replace(/#/gi, '\\#');

const sourceBranch = escapeHash(process.env['SYSTEM_PULLREQUEST_SOURCEBRANCH']);
const targetBranch = escapeHash(process.env['SYSTEM_PULLREQUEST_TARGETBRANCH']);

const baseProjectPath = join(__dirname, '..');

const tempMasterTasksPath = join(baseProjectPath, 'temp', 'tasks-versions', targetBranch);

if (!existsSync(tempMasterTasksPath)) {
  mkdir('-p', tempMasterTasksPath);
}

if (existsSync(join(tempMasterTasksPath, 'Tasks'))) {
  rm('-rf', join(tempMasterTasksPath, 'Tasks'));
}

if (existsSync(join(tempMasterTasksPath, '_generated'))) {
  rm('-rf', join(tempMasterTasksPath, '_generated'));
}

function checkMasterVersions(masterTasks, sprint, isReleaseTagExist, isCourtesyWeek) {
  const messages = [];

  for (const masterTask of masterTasks) {
    if (masterTask.version.minor <= sprint) {
      continue;
    }

    if (isReleaseTagExist || isCourtesyWeek) {
      continue;
    }

    messages.push({
      type: 'warning',
      payload: `[${targetBranch}] ${masterTask.name} has v${masterTask.version.version} it's higher than the current sprint ${sprint}`
    });
  }

  return messages;
}

function compareLocalWithMaster(localTasks, masterTasks, sprint, isReleaseTagExist, isCourtesyWeek) {
  const messages = [];

  for (const localTask of localTasks) {
    const masterTask = masterTasks.find(x => x.name.toLowerCase() === localTask.name.toLowerCase());

    if (masterTask === undefined) {
      console.log("compareLocalWithMaster: masterTask not found, skipping master checks");
    } else {
      if (localTask.version.minor < sprint) {
        const destinationVersion = parse(masterTask.version.version);
        destinationVersion.minor = sprint;

        messages.push({
          type: 'error',
          payload: `${localTask.name} have to be upgraded (task.json, task.loc.json) from v${localTask.version.version} to v${destinationVersion.format()} at least (${taskVersionBumpingDocUrl})`
        });
        continue;
      }

      if (localTask.version.minor === sprint && eq(localTask.version, masterTask.version)) {
        messages.push({
          type: 'error',
          payload: `${localTask.name} have to be upgraded (task.json, task.loc.json) from v${localTask.version.version} to v${inc(masterTask.version, 'patch')} at least (${taskVersionBumpingDocUrl})`
        });
        continue;
      }
    }

    if (localTask.version.minor === sprint && isCourtesyWeek) {
      messages.push({
        type: 'warning',
        payload: `Be careful with task ${localTask.name} version and check it attentively as the current week is courtesy push week`
      });
      continue;
    }

    if (localTask.version.minor > sprint && (!isReleaseTagExist && !isCourtesyWeek)) {
      messages.push({
        type: 'error',
        payload: `[${sourceBranch}] ${localTask.name} has v${localTask.version.version} it's higher than the current sprint ${sprint} (${taskVersionBumpingDocUrl})`
      });
      continue;
    }
  }

  return messages;
}

function getTasksVersions(tasks, basepath) {
  return tasks.filter(x=>{
    var taskDir = getTaskDir(x);

    const taskJSONPath = join(basepath, taskDir , x, 'task.json');

    if (!existsSync(taskJSONPath)) {
      return false;
    }

    return true;
  }).map(x => {
    var taskDir = getTaskDir(x);

    const taskJSONPath = join(basepath, taskDir , x, 'task.json');
    const taskJSONObject = JSON.parse(readFileSync(taskJSONPath, 'utf-8'));
    return {
      id: taskJSONObject.id,
      name: x,
      version: parse([
        taskJSONObject.version.Major,
        taskJSONObject.version.Minor,
        taskJSONObject.version.Patch
      ].join('.'))
    }
  });
}

async function clientWrapper(url) {
  try {
    return await client.get(url);
  } catch (error) {
    logToPipeline('error', `Cannot access to ${url} due to error ${error}`);
    process.exit(1);
  }
}

async function getFeedTasksVersions() {
  const { result, statusCode } = await clientWrapper(packageEndpoint);

  if (statusCode !== 200) {
    logToPipeline('error', `Failed while fetching feed versions.\nStatus code: ${statusCode}\nResult: ${result}`);
    process.exit(1);
  }

  return result.value
    .map(x => ({
      name: x.name.slice('Mseng.MS.TF.DistributedTask.Tasks.'.length),
      versions: x.versions.map(y => ({
        version: parse(y.version),
        isLatest: y.isLatest
      }))
    }));
}

function compareLocalWithFeed(localTasks, feedTasks, sprint) {
  const messages = [];

  for (const localTask of localTasks) {
    const feedTask = feedTasks.find(x => x.name.toLowerCase() === localTask.name.toLowerCase());

    if (feedTask === undefined) {
      continue;
    }

    for (const feedTaskVersion of feedTask.versions) {
      if (feedTaskVersion.version.minor > sprint) {
        messages.push({
          type: 'warning',
          payload: `[Feed] ${feedTask.name} has v${feedTaskVersion.version.version} it's higher than the current sprint ${sprint}`
        });
        continue;
      }

      if (lte(localTask.version, feedTaskVersion.version) && feedTaskVersion.isLatest) {
        messages.push({
          type: 'warning',
          payload: `[Feed] ${localTask.name} local version ${localTask.version.version} less or equal than version in feed ${feedTaskVersion.version.version}`
        });
      }
    }
  }

  return messages;
}

function compareLocalTaskLoc(localTasks) {
  const messages = [];

  for (const localTask of localTasks) {
    const taskLocJSONPath = join(__dirname, '..', getTaskDir(localTask.name), localTask.name, 'task.loc.json');

    if (!existsSync(taskLocJSONPath)) {
      logToPipeline('error', `Task.json of ${localTask.name} does not exist by path ${taskLocJSONPath}`);
      process.exit(1);
    }

    const taskLocJSONObject = JSON.parse(readFileSync(taskLocJSONPath, 'utf-8'));
    const taskLocJSONVersion = [taskLocJSONObject.version.Major, taskLocJSONObject.version.Minor, taskLocJSONObject.version.Patch].join('.');
    
    if (neq(localTask.version, parse(taskLocJSONVersion))) {
      messages.push({
        type: 'error',
        payload: `[Loc] ${localTask.name} task.json v${localTask.version.version} does not match with task.loc.json v${taskLocJSONVersion} (${taskVersionBumpingDocUrl})`
      });
    }
  }

  return messages;
}

function getChangedTaskJsonFromMaster(names) {
  names.forEach(x => {
    mkdir('-p', join(tempMasterTasksPath, getTaskDir(x), x));
    var tmp = `${tempMasterTasksPath.split(sep).join(posix.sep)}/${getTaskDir(x)}/${x}/task.json`;
    try
    {
      run(`git show origin/master:${getTaskDir(x)}/${x}/task.json > ${tmp}`);
    }
    catch (e)
    {
      rm(tmp);
      console.log(`main: failed to getTasksVersions for ${x}; assuming task or buildConfig not present in master; will skip version checks involving master`);
    }
  });
}

async function main({ task, sprint, week }) {
  const changedTasksNames = resolveTaskList(task);
  const localTasks = getTasksVersions(changedTasksNames, join(__dirname, '..'));
  var masterTasks;

  getChangedTaskJsonFromMaster(changedTasksNames);
  masterTasks = getTasksVersions(changedTasksNames, tempMasterTasksPath);

  const feedTasks = await getFeedTasksVersions();
  const isReleaseTagExist = run(`git tag -l v${sprint}`).length !== 0;
  const isCourtesyWeek = week === 3;

  const messages = [
    ...checkMasterVersions(masterTasks, sprint, isReleaseTagExist, isCourtesyWeek),
    ...compareLocalWithMaster(localTasks, masterTasks, sprint, isReleaseTagExist, isCourtesyWeek),
    ...compareLocalWithFeed(localTasks, feedTasks, sprint),
    ...compareLocalTaskLoc(localTasks)
  ];

  if (messages.length > 0) {
    console.warn(`\nProblems with ${messages.length} task(s) should be resolved:\n`);

    for (const message of messages) {
      logToPipeline(message.type, message.payload);
    }

    console.log('\nor you might have an outdated branch, try to merge/rebase your branch from master');

    // If only we have errors, we should fail the build
    if (messages.some(x => x.type === 'error')) {
      process.exit(1);
    }
  }
}

function getTaskDir(x) {
  return x.indexOf('_') > -1 ? '_generated' : 'Tasks';
}

main(argv);