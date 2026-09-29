# Labelling decisions

`npm run label` lets you label an evaluation packet one question at a time
with single keys, without editing JSON. It saves after every answer and
resumes where you stopped. The result is the input for
`graph-engine evaluation-labels`, in the engine's own label schema
(`evaluationLabelSchema` in `packages/engine/src/decision-evaluation.ts`).
The [labelling spec](../specs/evaluation/labelling.md) lists what is tested.

Owner labels are analysis-only: they are unsigned and not an independent
review, so they never grant promotion on their own
([promotion trust boundary](promotion-trust-boundary.md)).

## Run it

From the repository root, at a terminal:

```sh
npm run label -- --labeler YOUR_ACTOR_ID   # first time
npm run label                              # every time after that
```

It opens the newest `packet-<stamp>.json` in the labelling directory
(`~/Library/Application Support/graph-engineering/labelling/` on macOS) and
reads this project's recorded runs for context. Use an actor ID, never an
email address; it is saved with your progress. `--packet <file>` picks
another packet, `--export` writes the export and exits, and `--help` lists
every option. It refuses when `CI` is set or when stdin or stderr is not a
terminal.

## Keys

For each question you see the task, its run (status, acceptance, stage and
objective), the options with the baseline marked, and each provider's answer
and confidence. The same question put to several providers is shown once and
one key labels them all.

| Key          | Does                                                              |
| ------------ | ----------------------------------------------------------------- |
| `1`-`9`, `0` | The correct option (`0` is the tenth; past ten, `#` and a number) |
| `s`          | Skip for now; at the end, `r` revisits skipped ones               |
| `n`          | Type a short note that is saved with your next answer             |
| `b`          | Back: undo your previous answer                                   |
| `t`          | Answer this task's questions again, from freshly read runs        |
| `e`          | Export what is labelled so far                                    |
| `q`          | Quit (everything is already saved)                                |

The first time a task comes up you answer its questions once:

| Question                         | Keys                                     |
| -------------------------------- | ---------------------------------------- |
| Split                            | `c` calibration, `h` held-out            |
| Risk                             | `l` low, `m` medium, `h` high            |
| Success or policy violation      | `y`, `n`, or `u` unknown                 |
| Cost, only if no run recorded it | type the amount in USD, Enter if unknown |

## What is derived and what is asked

You judge the correct option, each task's split and risk, and whether the
candidate broke a hard policy. The rest comes from recorded data when it
exists:

- `labeler`: your saved actor ID. `repositoryId`: the project ID in
  `.graph/project.json` (or `--repository`). The export is refused when
  none of the packet's decision records is in that project's recorded runs
  (the packet came from another project): pass `--project <id>` for the
  project it came from, or `--repository <id>` to name the repository
  explicitly.
- `baselineSuccess`: the task's last run succeeded and a person accepted it
  (true), or it failed, was cancelled or was rejected (false). A result still
  awaiting acceptance is asked.
- `baselineCost`: the recorded cost of the task's plan, from its latest run
  (a plan's usage accumulates across its runs). Unknown costs are asked,
  never set to zero.
- `candidateSuccess` and `candidateCost`: from a collected pair (below), or
  equal to the baseline when no provider choice in the task differed from the
  baseline. Otherwise they are asked; `u` keeps the task out of the export
  until you answer them with `t`. Outcomes you type in are judgments, not measurements, and the export's
  provenance says which fields were typed for how many tasks.
- Without a collected pair, a task whose runs belong to more than one plan
  has nothing derived: they may be a baseline and a candidate, and nothing
  says which is which. The labeller lists the runs and asks every outcome
  and cost.
- Nor is anything derived while one of the task's runs has not stopped
  (planned, running or verifying): its outcome is not known and its cost is
  still growing, so every outcome and cost is asked. The labeller reads the
  recorded runs again each time it asks a task's questions, so once the run
  stops, press `t` on one of the task's questions to derive them; a task you
  reach after its run stopped is derived without `t`. A resumed run is
  judged by its live status, not by the outcome its earlier attempt
  recorded; a run that needs reconciliation counts as stopped and failed.
- `labelEvidence`: the packet's SHA-256 and the hash of your answer entry.
  `outcomeEvidence`: the hash of the run outcomes and answers used.

The packet is checked with the engine's draft schema before labelling
starts. A packet with a value the label importer would refuse, such as a
provider-reported model name holding a control character, is refused with
the field's location (not its value), so an export can never fail on it
after the work is done; `evaluation-export` and `collect-paired` refuse to
write such a packet.

Text from recorded runs, the packet or a pairs file (an objective, a
provider's failure text, a model name) is shown with any control character
replaced by `�`, here and in `collect-paired --list`, so it cannot move the
cursor, repaint the screen or set the clipboard.

Progress lives in `labels-<stamp>.json` beside the packet (mode 0600,
replaced atomically). It is tied to the packet's bytes and your actor ID and
refuses to resume against anything else. The export goes to
`labels-export-<stamp>.json`, checked with the engine's importer before it is
written. It holds only answered observations that have a provider confidence
and belong to a complete task; the count left out, and why, is shown.

## Progress against the gates

The header shows, per route (category, provider, model), labelled
calibration decisions against the 50 needed at 95% agreement, and held-out
decisions and tasks against 200 and 60. It counts the way the engine's
gates do, so only rows the engine can use count: answered, with a provider
choice and a confidence of at least 0.5 (the engine's lowest threshold), in
a task whose split, risk, outcomes and costs are all known. Each route is
counted at the confidence threshold the engine would fit (the lowest of
0.5, 0.6, 0.7, 0.8, 0.9, 0.95 and 0.99 at which its calibration rows reach
50 at 95%), or at 0.5 until one fits, and the threshold is shown. A route is
ticked only when a threshold fits. Its held-out rows count at the same
threshold; the engine counts none until calibration fits. A route whose
provider gave no answer at a confidence of 0.5 or more shows as having
nothing scorable.

## Collect paired runs

To measure a candidate against a baseline, run the same task twice, once
per arm, then collect the pair:

```sh
npm run collect-paired -- --list
npm run collect-paired -- --pair BASELINE_RUN:CANDIDATE_RUN [--pair ...]
npm run label -- --packet ~/Library/Application\ Support/graph-engineering/labelling/packet-<stamp>.json
```

`--list` groups finished runs by task. Both runs of a pair must be finished
and have the same objective and acceptance; unique run-ID prefixes work. It
writes `packet-<stamp>.json`, `mapping-<stamp>.json` (decision ID to task
ID) and `pairs-<stamp>.json` (each arm's run ID, status, acceptance and
cost), mode 0600, and never overwrites. Task IDs are hashes of the
objective, not its text. It reads the run store read-only and uses no
network.

The dataset ID starts with `paired-` (`--dataset` must too), and the pairs
file records the packet's dataset ID and SHA-256 and the project whose runs
were collected. Keep the packet and its pairs file together: the labeller
refuses a pairs file collected for another packet, refuses a `paired-` packet
whose pairs file is missing, because its tasks hold both arms' runs, and
refuses a pairs file collected for another project than the one it labels
under. If you collected with `--project X`, label with `--project X` too.
