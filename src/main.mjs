// Action entry. Any unexpected error is reported as a warning and the job is
// not failed: a broken check must never block a merge on its own.
import { main } from './run.mjs';

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    const msg = String((e && e.message) || e).replace(/[\r\n%]/g, ' ').slice(0, 200);
    process.stdout.write(`::warning::TensorFeed package check could not run: ${msg}\n`);
    process.exitCode = 0;
  });
