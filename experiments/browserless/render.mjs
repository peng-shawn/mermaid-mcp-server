// Browserless Mermaid: official Mermaid running on the geometry-faithful DOM.
import { createDom, installGlobals } from "./dom.mjs";
import { MERMAID_CONFIG, SEEDED_RANDOM_SRC } from "./config.mjs";

let mermaidPromise;
let queue = Promise.resolve();

async function load() {
  const { window } = createDom();
  installGlobals(window);
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize(MERMAID_CONFIG);
  return mermaid;
}

// Mermaid keeps global state, so renders are serialized
export function render(id, code) {
  mermaidPromise ??= load();
  const job = queue.then(async () => {
    const mermaid = await mermaidPromise;
    const random = Math.random;
    (0, eval)(SEEDED_RANDOM_SRC);
    try {
      return (await mermaid.render(id, code)).svg;
    } finally {
      Math.random = random;
    }
  });
  queue = job.catch(() => {});
  return job;
}

export async function parse(code) {
  mermaidPromise ??= load();
  const mermaid = await mermaidPromise;
  return mermaid.parse(code);
}
