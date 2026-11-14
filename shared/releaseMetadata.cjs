// ==================================================================
// 小轩音乐 · 闭源专有软件
// 主服务地址（脱敏占位符，构建/部署时注入真实裸域名）：__XUAN_SERVER_BASE__
// 本软件为闭源专有软件；未经授权强行逆向、破解、篡改、二次分发或绕过校验，须承担相应法律责任。
// ==================================================================
// shared/releaseMetadata.cjs
// Validates the three version sources that authorize a release.

const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const RELEASE_FILE_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+\r?\n?$/;

function validateReleaseMetadata({ commitMessage, releaseFileContent, packageVersion }) {
  if (!RELEASE_FILE_PATTERN.test(releaseFileContent)) {
    throw new Error('release file must contain exactly one A.B.C version line.');
  }

  const commitMatch = /^release: v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(commitMessage);
  if (!commitMatch) {
    throw new Error('Current complete commit message must exactly match release: vA.B.C.');
  }

  const releaseFileVersion = releaseFileContent.trim();
  const commitVersion = commitMatch[1];
  if (!RELEASE_VERSION_PATTERN.test(packageVersion)) {
    throw new Error('package.json version must be a plain A.B.C version.');
  }
  if (commitVersion !== releaseFileVersion || packageVersion !== releaseFileVersion) {
    throw new Error(`Release versions must match: commit=${commitVersion}, release-file=${releaseFileVersion}, package.json=${packageVersion}.`);
  }

  return releaseFileVersion;
}

module.exports = {
  validateReleaseMetadata,
};
