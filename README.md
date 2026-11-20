# github-forge-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Winter075/github-forge-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Winter075/github-forge-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A zero-dependency GitHub-compatible git forge. One Node server serves Git smart HTTP (upload-pack and receive-pack), REST v3, GraphQL v4 and MCP over a shared in-memory store, with SHA-1 object storage, packfiles, issues, pull requests, labels and squash merges.

## Run it

```sh
npm start
```

The entry binds an ephemeral port, registers with the trial environment through `MAKEFUN_ENV_URL`, and serves `/healthz` until the environment says the run is done. For local testing without the environment, run `node --experimental-strip-types local-runner.ts` and use port 18080.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tamdp7j6&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
