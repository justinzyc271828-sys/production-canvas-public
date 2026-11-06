# Independent review prompt

Review the current public Windows release of Production Canvas. Focus on the
direct experience of pausing on a frame, writing an annotation, saving it, and
returning to that exact frame during the next review.

Read README.md and run the source or its corresponding portable release.
The original sample has 30 seconds, 720 frames, 16 picture clips, four chapters,
and three placeholders. Save two nearby test annotations, restart, and return
from their markers. Check that version and frame identity remain clear and
that nearby annotations are easy to distinguish. Exercise zooming, narrow
windows, and crowded timeline markers. Copy the sample to another directory
and test opening its manifest and importing its folder.

If an optional local integration is configured, state the actual environment
used and verify the return to review. Give an overall assessment and at most
three prioritized findings. Include reproduction steps, impact, a proposed
change, and an acceptance check for each finding. Distinguish direct testing,
code-based inference, and remaining unknowns. Provide findings before changing
code unless the owner has explicitly requested implementation.
