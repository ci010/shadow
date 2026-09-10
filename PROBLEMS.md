> **Historical observations / open questions:** this is not a maintained
> issue-status dashboard; entries may be partly addressed or still exploratory.
> Check actual source and [current architecture](docs/architecture.md) before
> treating an entry as a current defect or an implemented feature.

- how agent narrow its attention and create a focused scope during the workflow execution?
  - the self-created subagent type is an example, by limit the scope and attention via system prompt, and specific tools set.
  - Scenarios
    - Science research agent: The agent might have search tool for famous paper website.


- Skill harvest do build skill, but as long as the llm does not refresh the sys prompt, the agent wont benefit from it

- 子agent created file should also be captured in parent agent sleep process.

- in webui, the skill-harvest and wiki builder are flatten in list, it's in-efficient, it should tree structure under the related session, but it should hide automatically