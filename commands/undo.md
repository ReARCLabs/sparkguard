---
description: Undo the agent's last file change (or a given step) with Said No.
---
Call the `said_no_steps` tool to list recent snapshotted steps, then call `said_no_undo` with the step the user asked for ($ARGUMENTS, or the latest step if none was given). Report which files were restored or removed. Do not edit files yourself to "undo".
