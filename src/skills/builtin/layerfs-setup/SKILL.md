---
name: layerfs-setup
description: "Owner workflow: approved LayerFS installation/runtime, standard Git/Docker/SDK exec preparation and immutable resource registration."
metadata:
  category: tools
---

# LayerFS setup

Read `v:skills/layerfs/setup.md` for the complete executable sequence. Do not stop at
installation: register the prepared official resource, create a workspace, run the
requested checks and continue the original task.

1. `layerfs_doctor`: inspect installation only, no connectivity claim.
2. If absent, `layerfs_bootstrap_plan` followed by its exact recorded human
   installation decision and `layerfs_bootstrap` (`allowDownloads` and root-worker
   consent remain required). The background job returns an `executionId`; use
   ordinary background completion/status, never replay uncertain provisioning.
3. Reuse approved artifacts: `layerfs_runtime_plan`, `layerfs_runtime_start` once.
   These routine calls require no approval object or recorded decision. The initial
   installation privilege boundary remains; arbitrary workers cannot start runtimes.
4. `layerfs_runtime_context` returns executable/launcher and nonsecret WSL parameters.
   Use ordinary exec, its logs, nonzero exit codes and background lifecycle. The
   launcher delegates only necessary official runtime APIs to the existing owner;
   standard agent SDK calls run directly in the exec process. No new worker is started.
5. Prepare an independent fixed Git checkout with standalone metadata and standard
   Git LFS commands, using existing local objects where possible. Build/inspect the
   image with Docker. No tar/archive repair, custom blob hydration or internal recipe
   engine. Do not read dirty credential files or put private-feed credentials in images.
6. Explicit official `runtime.project.start_init/get_init` and SDK baseline queries.
   Register `{name,runtimeId,layerfsProject,baselineRef,image,source:{repository,commit}}`
   via `layerfs_resource_register`. Ready means registered/identity-checked, not tested.

Do not replace installation with environment edits or ad hoc shell installers.
Unknown means inspect retained resources and report; it never means try Init again.
No old catalog migration, namespace switching or resource cleanup is implicit.
