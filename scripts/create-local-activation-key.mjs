const [selectionId, maximum = '1', expiresAt = 'never'] = process.argv.slice(2);

if (!selectionId) {
  console.error(
    'Usage: npm run activation-key:local:create -- <selection-id> [maximum-activations] [ISO-expiry|never]',
  );
  process.exitCode = 2;
} else {
  const response = await fetch(
    'http://127.0.0.1:8787/_local/admin/activation-keys',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scenario-Local-Admin': 'phase3-local-only',
      },
      body: JSON.stringify({
        selectionId,
        maximumActivations: Number(maximum),
        expiresAt: expiresAt === 'never' ? null : expiresAt,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    console.error(`Création refusée (${response.status})`, body);
    process.exitCode = 1;
  } else {
    console.log(
      'Clé locale créée. Copiez-la maintenant : elle ne sera plus affichée.',
    );
    console.log(body.key);
    console.log(`Identifiant de révocation : ${body.id}`);
  }
}
