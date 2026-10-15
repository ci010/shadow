```answer-html
<section class="answer-callout" data-md>
**Illustrative architecture only** — not production-verified.
</section>
<div class="answer-grid">
  <article class="answer-card" data-md>
### Network
Public edge → private service network.
  </article>
  <article class="answer-card" data-md>
### Control plane
Schedules game hosts; manages desired state.
  </article>
  <article class="answer-card" data-md>
### Game hosts
Run sessions; publish health to the control plane.
  </article>
  <article class="answer-card" data-md>
### Object storage
Stores builds and snapshots separately from live traffic.
  </article>
</div>
<div class="answer-flow"><span class="answer-badge">Client</span><span>→ Network → Game host</span></div>
<details><summary>Design caveats</summary><div data-md>
- Validate capacity, isolation and recovery before deployment.
- Keep storage credentials scoped to each workload.
</div></details>
```
