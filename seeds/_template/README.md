# Seed template

The three CSVs `pnpm new-site` copies into `seeds/<niche>/` when the operator
chooses `template` as the seed source. They are not loadable as they stand:
`{{...}}` placeholders are substituted from the wizard's answers, which is how
the example rows end up talking about the right kind of thing without any
niche word living in the codebase.

| Placeholder       | Filled with                                          |
| ----------------- | ---------------------------------------------------- |
| `{{singular}}`    | `entity.singular`                                     |
| `{{Singular}}`    | `entity.Singular`                                     |
| `{{plural}}`      | `entity.plural`                                       |
| `{{Plural}}`      | `entity.Plural`                                       |
| `{{country}}`     | the ISO country code                                  |
| `{{regionLabel}}` | "county", "state", "province" — from the country      |
| `{{RegionLabel}}` | the same, capitalised                                 |
| `{{postcode}}`    | the country profile's example postcode                |
| `{{phone}}`       | the country profile's reserved-for-fiction number     |

The rows are examples to replace, not data to ship. Latitude and longitude are
deliberately blank — the map needs real coordinates, and a plausible wrong one
is worse than an obvious gap. Every city seeded this way starts non-indexable;
it earns indexing by clearing `seo.minListingsToIndex` and having intro copy.

Editing a header here changes what `scripts/seed.ts` reads. Keep the two in
step, and keep `REQUIRED_SEED_HEADERS` in `lib/clone/scaffold-seed.ts` honest
about which columns the loader genuinely cannot do without.
