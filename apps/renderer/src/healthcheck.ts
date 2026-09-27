/**
 * The image's healthcheck (`node dist/healthcheck.js`; the image has no
 * wget): 0 when the renderer answers 200 on /healthz, 1 otherwise.
 */
const port = Number(process.env.PORT) || 3100;

fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4_000), redirect: 'error' }).then(
  async (res) => {
    await res.body?.cancel().catch(() => {});
    process.exit(res.status === 200 ? 0 : 1);
  },
  () => process.exit(1)
);
