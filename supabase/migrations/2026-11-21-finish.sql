-- Card finish (standard / reverse holo / holo / 1st edition) per owned row.
alter table public.owned_cards add column if not exists finish text;
