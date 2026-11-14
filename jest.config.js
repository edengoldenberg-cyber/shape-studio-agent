'use strict';
module.exports = {
  testEnvironment: 'node',
  // Sets TEST_NO_BIND, a fresh temp DATA_DIR and dummy external credentials before any
  // test file loads (see tests/jest_global_setup.js).
  setupFiles: ['./tests/jest_global_setup.js'],
  // Exclude the git worktree clone (created by Claude Code agents) from test discovery.
  // LIVE-SERVER suites are excluded from the isolated run: they talk to whatever is
  // listening on localhost:3000 and share that server's data directory, so they are not
  // isolated tests. Run them explicitly against a server you started yourself:
  //   npx jest --testPathIgnorePatterns /node_modules/ -- tests/barak_pipeline.test.js tests/video_endpoint.test.js
  testPathIgnorePatterns: ['/node_modules/', '/.claude/', 'barak_pipeline\\.test\\.js$', 'video_endpoint\\.test\\.js$'],
  modulePathIgnorePatterns: ['/.claude/'],
  // server.js keeps timers/cron handles alive after tests finish. Without forceExit every
  // Jest run stayed alive forever as an orphan process that kept rewriting data files.
  forceExit: true,
  testTimeout: 20000,
};
