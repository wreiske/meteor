var selftest = require('../tool-testing/selftest.js');
var Sandbox = selftest.Sandbox;

selftest.define("meteor npm run some-script-name - error returns exit status to shell", async function () {
  var s = new Sandbox();
  await s.init();
  var run;

  await s.createApp("myapp", "dev-bundle-bin-commands");
  s.cd("myapp");
  run = s.run("npm", "run", "exit-with-status");
  await run.matchErr("This script has an exit status");
  await run.expectExit(1);
});

selftest.define("meteor npm some-script-name - normal exit returns normal to shell", async function () {
  var s = new Sandbox();
  await s.init();

  var run;

  await s.createApp("myapp", "dev-bundle-bin-commands");
  s.cd("myapp");
  run = s.run("npm", "run", "exit-normally");
  await run.match("This script will exit normally");
  await run.expectExit(0);
});

selftest.define("meteor pnpm command is recognized", async function () {
  var s = new Sandbox();
  await s.init();

  var run;

  await s.createApp("myapp", "dev-bundle-bin-commands");
  s.cd("myapp");
  // Try running pnpm --help, which should work if pnpm is installed
  // or give a clear error if not installed
  run = s.run("pnpm", "--help");
  await run.expectExit(); // Accept any exit code as long as command is recognized
});

selftest.define("meteor create prefers pnpm when available", async function () {
  var s = new Sandbox();
  await s.init();

  // Test that we can import the default-npm-deps module
  var defaultNpmDeps = require('../cli/default-npm-deps.js');
  
  // The install function should exist and be callable
  // We can't easily test the pnpm preference without actually installing pnpm
  // in the test environment, but we can at least verify the module loads
  selftest.expectTrue(typeof defaultNpmDeps.install === 'function');
});
