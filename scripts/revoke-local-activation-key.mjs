const [keyId] = process.argv.slice(2);

if (!keyId) {
  console.error('Usage: npm run activation-key:local:revoke -- <key-id>');
  process.exitCode = 2;
} else {
  const response = await fetch(
    `http://127.0.0.1:8787/_local/admin/activation-keys/${encodeURIComponent(keyId)}`,
    {
      method: 'DELETE',
      headers: { 'X-Scenario-Local-Admin': 'phase3-local-only' },
    },
  );
  if (!response.ok) {
    console.error(`Révocation refusée (${response.status})`);
    process.exitCode = 1;
  } else {
    console.log('Clé locale révoquée.');
  }
}
