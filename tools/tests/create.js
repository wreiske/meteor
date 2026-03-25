var selftest = require('../tool-testing/selftest.js');
const { AVAILABLE_SKELETONS } = require("../cli/commands");
var Sandbox = selftest.Sandbox;
const SIMPLE_WAREHOUSE = { v1: { recommended: true } };

selftest.define("create main", async function () {
  // We need a warehouse so the tool doesn't think we are running from checkout
  var s = new Sandbox({ warehouse: SIMPLE_WAREHOUSE });
  await s.init();

  // Can we create an app? Yes!
  var run = s.run("create", "foobar", "--legacy");
  await run.match("Created a new Meteor app in 'foobar'.");
  await run.match("To run your new app");
  await run.expectExit(0);

  // Test that the release constraints have been written to .meteor/packages
  s.cd("foobar");
  const packages = s.read(".meteor/packages");
  if (!packages.match('meteor-base@')) {
    selftest.fail("Failed to add a version specifier to `meteor-base` package");
  }

  const packageJson = JSON.parse(s.read("package.json"));
  if (! packageJson.dependencies.hasOwnProperty("@babel/runtime")) {
    selftest.fail("New app package.json does not depend on @babel/runtime");
  }

  // Install basic packages like babel-runtime and meteor-node-stubs from
  // package.json.
  run = s.run("npm", "install");
  await run.expectExit(0);

  // Now, can we run it?
  run = s.run();
  await run.match("foobar");
  await run.match("proxy.");
  // Do not print out the changes to the versions file!
  run.waitSecs(5);
  await run.read("=> Started MongoDB", false);
  run.waitSecs(30);
  await run.match("your app");
  await run.match("running at");
  await run.match("localhost");
  await run.stop();

  run = s.run("create", "--list");
  await run.read('Available');
  await run.match('react');
  await run.expectExit(0);
});

selftest.define("create --from-template invalid format", async function () {
  var s = new Sandbox({ warehouse: SIMPLE_WAREHOUSE });
  await s.init();

  // Invalid format (no slash)
  var run = s.run("create", "--from-template", "invalidformat", "testapp");
  await run.matchErr("Invalid template format");
  await run.matchErr("owner/repo");
  await run.expectExit(1);
});

selftest.define("create --from-template non-meteor repo", ["net"], async function () {
  var s = new Sandbox({ warehouse: SIMPLE_WAREHOUSE });
  await s.init();

  // A well-known repo on GitHub that does NOT have a .meteor folder
  var run = s.run("create", "--from-template", "expressjs/express", "testapp");
  run.waitSecs(30);
  await run.match("Verifying");
  await run.matchErr("does not appear to be a Meteor project");
  await run.expectExit(1);
});

selftest.define("create --from-template success", ["net", "slow"], async function () {
  var s = new Sandbox({ warehouse: SIMPLE_WAREHOUSE });
  await s.init();

  // Use one of Meteor's own skeleton repos (small, known to have .meteor)
  var run = s.run("create", "--from-template", "meteor/skel-react", "myapp");
  run.waitSecs(60);
  await run.match("Verifying");
  await run.match("Verified");
  await run.match("Created a new Meteor app in 'myapp'");
  await run.expectExit(0);

  // Verify .meteor folder exists in the created app
  s.cd("myapp");
  const packages = s.read(".meteor/packages");
  if (!packages) {
    selftest.fail("Expected .meteor/packages to exist in cloned template");
  }
});

selftest.define("create --from-template full github url", async function () {
  var s = new Sandbox({ warehouse: SIMPLE_WAREHOUSE });
  await s.init();

  // Invalid full URL (not github)
  var run = s.run("create", "--from-template", "https://gitlab.com/foo/bar", "testapp");
  await run.matchErr("Invalid template format");
  await run.expectExit(1);
});

selftest.define("create --from-template defaults app name to repo", ["net", "slow"], async function () {
  var s = new Sandbox({ warehouse: SIMPLE_WAREHOUSE });
  await s.init();

  // No app name argument — should default to the repo name
  var run = s.run("create", "--from-template", "meteor/skel-react");
  run.waitSecs(60);
  await run.match("Verifying");
  await run.match("Verified");
  await run.match("Created a new Meteor app in 'skel-react'");
  await run.expectExit(0);
});

// TODO: Enable once rspack is published for the first time
// Also, the new modern test suite covers more than this test.
// This test may not work, as rspack relies on project npm dependencies
// being installed, and this suite apparently does not install them.
/* AVAILABLE_SKELETONS.forEach(template => {
  selftest.define("create --" + template, async function () {
    const s = new Sandbox;
    await s.init();

    // Can we create an app? Yes!
    let run = s.run("create", "--" + template, template);
    run.waitSecs(40);
    await run.match("Created a new Meteor app in '" + template + "'.");
    await run.match("To run your new app");

    s.cd(template);
    run = s.run();
    run.waitSecs(40);
    await run.match(template);
    await run.match("proxy")
    run.waitSecs(40);
    await run.match("your app");
    run.waitSecs(5);
    await run.match("running at");
    await run.match("localhost");

    await run.stop();
  });
}); */
