const seq = ["sequenceDiagram","  participant A as Client","  participant B as API"]; for (let i=0;i<6;i++) seq.push(`  A->>B: request ${i}`, `  B-->>A: response ${i}`);
const builtin = {
  flowchart: "flowchart TD\n  A[Start] --> B{Is it valid?}\n  B -->|Yes| C[Process order]\n  B -->|No| D[Reject]\n  C --> E[(Database)]\n  subgraph Backend\n    C\n    E\n  end",
  sequence: seq.join("\n") + "\n  Note over A,B: done\n  alt ok\n    B->>A: 200\n  else fail\n    B->>A: 500\n  end",
  class: "classDiagram\n  class Animal {\n    +String name\n    +eat() void\n  }\n  Animal <|-- Dog\n  Animal <|-- Cat\n  Dog : +bark()",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> Crashed : error\n  Crashed --> [*]",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n  CUSTOMER {\n    string name\n    int id PK\n  }",
  gantt: "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task 1 :a1, 2026-01-01, 30d\n  Task 2 :after a1, 20d",
  pie: "pie title Pets\n  \"Dogs\" : 386\n  \"Cats\" : 85",
  mindmap: "mindmap\n  root((Project))\n    Goals\n      Speed\n    Risks",
  gitGraph: "gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev",
  timeline: "timeline\n  title History\n  2024 : v1\n  2025 : v2",
  journey: "journey\n  title Day\n  section Work\n    Code: 5: Me",
  xychart: "xychart-beta\n  title Sales\n  x-axis [jan, feb, mar]\n  y-axis 0 --> 100\n  bar [20, 50, 80]",
  architecture: "architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api\n  service srv(server)[Server] in api\n  db:L -- R:srv",
  quadrant: "quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]",
  block: "block-beta\n  columns 2\n  a b",
  c4: "C4Context\n  Person(u, \"User\")\n  System(s, \"System\")\n  Rel(u, s, \"Uses\")",
};

// CORPUS=docs selects every mermaid-example block from Mermaid's own syntax docs
import fs from "fs";
export const cases =
  process.env.CORPUS === "docs"
    ? JSON.parse(fs.readFileSync(new URL("./corpus-docs.json", import.meta.url), "utf8"))
    : builtin;
