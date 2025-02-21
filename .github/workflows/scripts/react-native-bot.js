function writeComment(context, github, commentBody) {
  github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.issue.number,
    body: commentBody,
  });
}

function handleFailure(context, github) {
  writeComment(
    context,
    github,
    "⚠️ Sorry but I couldn't understand your request."
  );
}

function handleError(context, github, message, consoleOutput) {
  console.log(`❌ Error: ${message}`);
  let composedMessage = `❌ I failed to process your request with this error:\n\`\`\`\n${message}\n\`\`\``;
  if (consoleOutput) {
    composedMessage += `\n**console output:**\n\`\`\`\n${consoleOutput}\n\`\`\``;
  }
  writeComment(context, github, composedMessage);
}

// First parse the command as if it is a react-native-bot merge <SHA> <branch>
function handleMergeCommand(context, github, commentBody) {
  const [botName, command, sha, branch] = commentBody.trim().split(" ");
  if (
    botName !== "@react-native-bot" ||
    command !== "merge" ||
    !sha ||
    !branch
  ) {
    handleFailure(context, github);
    return;
  }
  const execSync = require("child_process").execSync;

  const tokenSecret = process.env.REACT_NATIVE_BOT_GITHUB_TOKEN;

  try {
    console.log(`▶️ Cloning react-native repository...`);
    execSync(
      `git clone -b main --single-branch https://${tokenSecret}@github.com/facebook/react-native.git`,
      {
        stdio: "inherit",
      }
    );
  } catch (error) {
    handleError(
      context,
      github,
      `Failed to clone with: ${error.status} with '${error.message}'`
    );
    return;
  }

  try {
    console.log(`▶️ Checking out to the requested branch: ${branch}`);
    execSync(`cd react-native; git fetch origin ${branch}:${branch}`, {
      stdio: "inherit",
    });
    execSync(`cd react-native; git checkout ${branch}`, {
      stdio: "inherit",
    });
  } catch (error) {
    handleError(
      context,
      github,
      `Failed to checkout branch ${branch} with: ${error.status} with '${error.message}'`
    );
    return;
  }

  try {
    console.log(`▶️ Attempting to cherry pick: ${sha}`);
    execSync(`git config --global user.email "bot@reactnative.dev"`);
    execSync(`git config --global user.name "React Native Bot"`);
    execSync(`cd react-native; git cherry-pick ${sha}`, {
      stdio: "inherit",
    });
  } catch (error) {
    let consoleOutput = execSync(`cd react-native; git status`).toString();
    console.log("Console output is ", consoleOutput);
    handleError(
      context,
      github,
      `Failed to cherry-pick ${sha} on branch ${branch} with: ${error.status} with '${error.message}'`,
      consoleOutput
    );
    return;
  }

  try {
    console.log(`▶️ Attempting to push on the remote branch: ${branch}`);
    execSync(`cd react-native; git push origin HEAD`, {
      stdio: "inherit",
    });
  } catch (error) {
    handleError(
      context,
      github,
      `Failed to push the pick on branch ${branch} with: ${error.status} with '${error.message}'`
    );
    return;
  }

  writeComment(
    context,
    github,
    `✅ Successfully picked up your commit https://github.com/facebook/react-native/commit/${sha} on the branch https://github.com/facebook/react-native/commits/${branch}`
  );

  github.rest.issues.update({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.issue.number,
    state: "closed",
  });
}

module.exports = ({ github, context }) => {
  const commentBody = context.payload.comment.body;
  if (commentBody.trim() === "@react-native-bot help") {
    writeComment(
      context,
      github,
      "ℹ️ Usage: `react-native-bot merge <SHA> <branch>`"
    );
  } else if (commentBody.trim().startsWith("@react-native-bot merge")) {
    handleMergeCommand(context, github, commentBody);
  } else {
    writeComment(
      context,
      github,
      "⚠️ Sorry, I didn't understand that. Please try again or type `@react-native-bot help` for more information."
    );
  }
};
