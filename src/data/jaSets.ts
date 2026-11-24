/**
 * What the English-speaking world calls the older Japanese sets. Those cards print no set
 * code and the catalogue holds no art for most of them, so the set name is how a print is
 * told apart in a search; the Japanese names mean little to the user.
 */
export const JA_SET_EN: Record<string, string> = {
  PMCG1: 'Base Set (Expansion Pack)',
  PMCG2: 'Jungle',
  PMCG3: 'Fossil',
  PMCG4: 'Team Rocket',
  PMCG5: 'Gym Heroes (Leaders\' Stadium)',
  PMCG6: 'Gym Challenge (Challenge from the Darkness)',
  neo1: 'Neo Genesis',
  neo2: 'Neo Discovery',
  neo3: 'Neo Revelation',
  neo4: 'Neo Destiny',
  VS1: 'Pokémon VS',
  web1: 'Pokémon Web',
  E1: 'Expedition (Base Expansion Pack)',
  E2: 'Aquapolis (The Town on No Map)',
  E3: 'Skyridge (Wind from the Sea)',
  E4: 'Split Earth / Mysterious Mountains',
  E5: 'Split Earth / Mysterious Mountains',
}

/** English name of a Japanese set when one is known: "ja:PMCG2" → "Jungle". */
export const jaSetEn = (setId: string): string | null => JA_SET_EN[setId.replace(/^ja:/, '')] ?? null
