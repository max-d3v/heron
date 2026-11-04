// A semantic-release plugin (.releaserc.json) for the Release workflow. It hands the next version to
// the build jobs, which stamp it into the app, and stops a release whose version differs from the one
// the installers were built with.
import { appendFileSync } from "node:fs";

export function verifyRelease(_config, { nextRelease, logger }) {
  const { version } = nextRelease;
  const built = process.env.HERON_BUILT_VERSION;
  if (built && built !== version) {
    throw new Error(`The installers were built as ${built}, but this release would be ${version}.`);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  logger.log("Next version: %s", version);
}
