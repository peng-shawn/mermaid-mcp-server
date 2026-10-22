// Benchmark diagrams, from trivial to Mermaid's edge limit
export default {
  small: "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A",
  sequence120: ["sequenceDiagram", ...Array.from({ length: 120 }, (_, i) => `  A->>B: message number ${i}`)].join("\n"),
  class40: ["classDiagram", ...Array.from({ length: 40 }, (_, i) => `  class C${i} {\n    +String name${i}\n    +run${i}() void\n  }\n  C${i} <|-- C${(i * 7 + 1) % 40}`)].join("\n"),
  chain400: ["flowchart TD", ...Array.from({ length: 400 }, (_, i) => `  N${i} --> N${i + 1}`)].join("\n"),
  dense490: ["flowchart TD", ...Array.from({ length: 490 }, (_, i) => `  N${i % 120} --> N${(i * 37 + 11) % 120}`)].join("\n"),
  subgraphs40: ["flowchart TD", ...Array.from({ length: 40 }, (_, g) => [`  subgraph S${g}`, ...Array.from({ length: 10 }, (_, i) => `    G${g}N${i}[Node ${g}.${i}] --> G${g}N${(i + 1) % 10}`), "  end"]).flat(), ...Array.from({ length: 60 }, (_, i) => `  G${i % 40}N0 --> G${(i * 7) % 40}N5`)].join("\n"),
};
