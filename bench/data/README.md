# Public benchmark data

`locomo10.json` is not committed because it is an external dataset. Fetch it with:

```powershell
node bench/fetch-public.mjs
```

Source: `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`
SHA-256: `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`

`bench/public-retrieval.mjs` measures **retrieval only** (evidence recall and
nDCG), not the official LoCoMo QA score. The official score needs an answer
generator and the benchmark judge.
