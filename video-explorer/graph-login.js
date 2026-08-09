'use strict';

// One-off sign-in for Microsoft Graph. Run:  node graph-login.js
// Prints a code to enter at microsoft.com/devicelogin, then caches the token.

const graph = require('./graph');

(async () => {
  if (graph.isSignedIn()) {
    try {
      const me = await graph.whoAmI();
      console.log(`Already signed in as ${me.displayName} (${me.driveType} drive)`);
      return;
    } catch {
      console.log('Cached token is no longer valid; signing in again.');
    }
  }

  console.log(`client:  ${graph.CLIENT_ID}`);
  console.log(`tenant:  ${graph.TENANT}`);
  console.log('');

  const code = await graph.requestDeviceCode();
  console.log('='.repeat(60));
  console.log(`  Open:  ${code.verification_uri}`);
  console.log(`  Code:  ${code.user_code}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('Sign in with the account that owns the OneDrive holding your videos.');
  console.log('Waiting...');

  await graph.pollForToken(code.device_code, code.interval, code.expires_in);

  const me = await graph.whoAmI();
  console.log('');
  console.log(`Signed in as ${me.displayName}`);
  console.log(`Drive: ${me.driveType}, ${me.quotaUsedGB} GB used of ${me.quotaTotalGB} GB`);
  console.log(`Token cached at ${graph.TOKEN_FILE}`);
})().catch((err) => {
  console.error('');
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
