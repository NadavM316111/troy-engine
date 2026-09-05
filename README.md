# NEURON

Continual learning that does not break.

A retention mechanism for models learning from a live stream, measured
across a grid world, real weather from five climates, and a 7-billion
parameter language model. The central claim is established causally: remove
the cause and the effect vanishes.

Six days of work, about twenty dollars of rented GPU, one laptop.

---

## The result in one table

Does the retention layer help? It depends on one thing, and only one.

| setting | effect |
|---|---|
| small world, contradictory rule phases | large win |
| real weather, chronological | large win, 5 of 5 climates |
| 7B language model, ordered phases | large win, 3 of 3 seeds |
| stationary grid world | no effect |
| noisy grid world | slightly negative |
| Fashion-MNIST images | inside the noise |
| **the same weather data, shuffled** | **slightly negative** |

**It helps exactly when the stream is non-stationary, and costs a little
when it is not.**

That last row is the proof. Same data, same amount, only the order
destroyed. The advantage does not shrink — it goes to zero.

| shuffle control | ordered | shuffled | collapse |
|---|---|---|---|
| Chicago | +11.51 | -1.56 | +13.07 |
| Singapore | +5.21 | -1.12 | +6.33 |
| Phoenix | +17.38 | -2.68 | +20.06 |
| 7B language model | +1.242 | -0.103 | +1.345 |

---

## Running it

Everything is plain PyTorch on CPU. No GPU needed except for the 7B
experiments, which expect a rented machine.

```bash
pip install torch numpy
./run.sh experiments/uncertainty/pf_check.py     # 10 seconds, checks setup
./run.sh experiments/inheritance/merge.py        # 20 minutes
./run.sh experiments/grid/grow.py                # 15 minutes
```

`run.sh` puts `core/` and `worlds/` on the path and runs from `results/`,
so outputs land beside the existing ones. Experiments use flat imports
(`from world import ...`), which is why the runner exists rather than a
package.

Some experiments download data on first run and cache it. The weather
experiments fetch from Open-Meteo's free archive; no key needed.

---

## Layout

```
core/          the library
  stability.py     the retention layer: gate, veto, rehearsal, guard,
                   sequence replay, replay policies
  llm_backend.py   transformer + LoRA, for the 7B experiments
  fake_backend.py  a dict-based backend proving the layer needs no ML

worlds/        environments
  world.py         9x9 grid, three contradictory rule sets
  bigworld.py      25x25, 21 outcomes, 6 hidden variables
  noisy.py         the same seen through imperfect senses
  sensor.py        real hourly weather

experiments/
  grid/            growing from nothing, rungs 1-5
  scale/           100k to 7B parameters, and the credit-assignment bug
  speed/           where the time actually goes
  uncertainty/     seven attempts at holding a belief loosely
  inheritance/     merging, generations, cold start
  language/        the 2026 fact-injection work
  local/           reproducing CLAPP, falsifying SAL

results/       every .json and .log this produced
docs/          the write-up and the competence curve
archive/       superseded scripts, kept for provenance
```

---

## What is established

**Retention through rehearsal works, and works because it is retention.**
Proven by removing the cause in two independent settings.

**It scales.** Holds across a 36-fold network size sweep and at 7 billion
parameters, 3 of 3 seeds. Protection costs about 4.5x and that multiplier
does not shrink with size.

**It prevents divergence, separately.** In a shuffled control the
unprotected arm's damage varied by 3.143 across seeds — one run blew up.
The protected arm varied by 0.183 with nothing to retain. Two jobs, not one.

**A network can grow from nothing.** Random weights, single-pass stream,
never revisited. It beats the standard baseline for real weather across
five climates and matches conventional multi-pass training.

**Inheritance works and compounds.** A newcomer seeded from a 16-way merge
needs 500 steps to reach what a blank one takes 6,000 to reach. Across six
generations, merged populations improve while a never-merging control
degrades from 36.89% to 9.35%.

**Speed in the single-sample regime is solved.** 2.4 to 4.3x, by not
stepping the optimiser every sample.

---

## What is not

**Frontier scale.** Untestable on any affordable budget.

**Learning a person.** Rung 5 failed five ways. Shell history was one day's
work. File timestamps turned out to record package managers, not a person.
Browser history came six points short. Deliberate app logging collapsed to
the majority class, and reformulating it did not beat "you will still be
where you are." The honest diagnosis is that collectable personal data does
not contain the causes of behaviour.

**The no-training-run half of the vision.** Local learning rules reproduce
and match backpropagation on small problems, but save memory rather than
time. That is a field-wide open problem.

**Uncertainty about stored beliefs.** Seven attempts. The fifth worked and
recovers about half the gap: when a reading is ambiguous, sample several
interpretations of it and carry them forward as separate hypotheses. The
weighting machinery on top of that turned out to be decoration.

**Merging across an architecture change.** Three approaches failed.
Same-architecture upgrades carry about half their learning; architecture
changes do not carry usefully.

---

## What is disproved

**Teaching a language model facts from a real text stream by gradient
updates converts honest refusals into confident fabrications.** Every probe
tested, both arms. Before: four honest "I don't know". After: seven
fabrications and one correct fact.

Different arms invented *different* wrong answers to the same question,
which shows the model generates domain-shaped text rather than recalling
anything.

For factual content, retrieval remains the working approach. Continual
learning by weight update looks right for skills, patterns and structure,
and wrong for facts.

---

## Method notes

Eight controls failed in ways that changed conclusions. The patterns are
consistent enough to be rules, and they are the most portable thing here.

**Check the test can fail before running it.** A world where the interesting
events are 0.4% of the stream cannot measure whether they are learned,
because ignoring them minimises the loss.

**Hiding a variable is not enough to test memory.** If its value is
predictable from base rates, a memoryless model matches a remembering one.

**A moving baseline produces artifact curves.** Advantage swung from +2.7 to
+32.8 across a sweep purely because the guess rate moved from 63% to 96%.

**A control that has not converged is not a control.** A fix appeared to
close 77% of a gap at half training length and 23% at full length.

**Score where the task disagrees with itself.** Whole-stream accuracy hid a
28.7-point gap behind a 3.1-point one.

**Never test a retention mechanism on a stationary stream.** Made this
mistake three times. If nothing drifts away there is nothing to retain.

**Identical numbers across different architectures mean collapse**, not
agreement.

**A transformation that should preserve behaviour must be checked.**
Permuting a network's units relabels them without changing the function. A
first implementation scored 11.89% — worse than doing nothing — and looked
like a clean negative result. The only reason it was caught is a check that
could only fail if the implementation were wrong.

---

## The bug worth knowing about

Every experiment detached the recurrent hidden state after every step, so
gradients reached back exactly one step. The network was told it predicted
wrongly and could only adjust the weights that processed *that moment*.
Nothing ever pushed it to have stored the relevant fact sixty steps earlier.

**Whatever memory it had was incidental.** The recurrent cell happens to
carry information forward and the one-step gradient happened to exploit it.
It was never trained to remember on purpose.

Fixing it closed 23% of the memory gap. A first version of the fix appeared
to close 77%, but was measured against an undertrained control.

---

## Reading further

`docs/neuron.md` is the full write-up: every result, every failure, and the
reasoning behind both. `docs/neuron_curve.png` is competence over a
100,000-step life, with the phase changes marked.

`results/` holds the raw output of every experiment in this repo. Nothing in
the write-up is unsupported by a file there.
