-- Phase 9: publish the initial server-owned commercial catalogue.
-- Values come from docs/commercial/01-OFFRES-REFERENCE.md and are never copied
-- into the client. Stripe price references remain absent until test Prices exist.

insert into public.offers (id, offer_code)
values
  ('91000000-0000-4000-8000-000000000101', 'discovery'),
  ('91000000-0000-4000-8000-000000000102', 'author_ai'),
  ('91000000-0000-4000-8000-000000000103', 'studio');

insert into public.offer_configuration_versions (
  id, version_number, status, effective_at, published_at, checksum, immutable_at
)
values (
  '91000000-0000-4000-8000-000000000001',
  1,
  'active',
  '2026-09-12T00:00:00Z',
  '2026-09-12T00:00:00Z',
  encode(extensions.digest('scenario-commercial-reference-v1', 'sha256'), 'hex'),
  '2026-09-12T00:00:00Z'
);

insert into public.offer_configuration_items (
  id, configuration_version_id, offer_id, locale, display_name, description,
  billing_period, currency, price_minor, tax_included, offline_grace_days,
  device_limit, is_visible
)
values
  (
    '91000000-0000-4000-8000-000000000201',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000101',
    'fr-FR', 'Découverte', 'Écriture locale pour découvrir Scénario.',
    'none', 'EUR', 0, true, 0, 1, true
  ),
  (
    '91000000-0000-4000-8000-000000000202',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000102',
    'fr-FR', 'Auteur IA', 'Écriture augmentée pour un auteur.',
    'month', 'EUR', 880, true, 7, 2, true
  ),
  (
    '91000000-0000-4000-8000-000000000203',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000102',
    'fr-FR', 'Auteur IA', 'Écriture augmentée pour un auteur.',
    'year', 'EUR', 8800, true, 7, 2, true
  ),
  (
    '91000000-0000-4000-8000-000000000204',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000103',
    'fr-FR', 'Studio', 'Collaboration et synchronisation pour une équipe.',
    'month', 'EUR', 1500, true, 7, 3, true
  ),
  (
    '91000000-0000-4000-8000-000000000205',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000103',
    'fr-FR', 'Studio', 'Collaboration et synchronisation pour une équipe.',
    'year', 'EUR', 15000, true, 7, 3, true
  );

insert into public.offer_entitlements (
  configuration_version_id, offer_id, entitlement_code, value
)
select
  '91000000-0000-4000-8000-000000000001'::uuid,
  offer.id,
  entitlement.code,
  'true'::jsonb
from (
  values
    ('discovery', 'local.edit'),
    ('author_ai', 'local.edit'),
    ('author_ai', 'ai.actions'),
    ('author_ai', 'ai_short_action'),
    ('author_ai', 'ai_pdf_import'),
    ('studio', 'local.edit'),
    ('studio', 'ai.actions'),
    ('studio', 'ai_short_action'),
    ('studio', 'ai_pdf_import'),
    ('studio', 'cloud.sync'),
    ('studio', 'cloud_sync'),
    ('studio', 'scenario_versions'),
    ('studio', 'scenario_compare'),
    ('studio', 'colored_revision'),
    ('studio', 'scene_cards'),
    ('studio', 'planning_tools'),
    ('studio', 'reports'),
    ('studio', 'pro_formats'),
    ('studio', 'read_share'),
    ('studio', 'instagram_center'),
    ('studio', 'studio_collaboration')
) as entitlement(offer_code, code)
join public.offers offer on offer.offer_code = entitlement.offer_code;

insert into public.offer_quotas (
  configuration_version_id, offer_id, quota_code, limit_value, period
)
select
  '91000000-0000-4000-8000-000000000001'::uuid,
  offer.id,
  quota.code,
  quota.limit_value,
  'month'
from (
  values
    ('author_ai', 'ai_short_action', 600),
    ('author_ai', 'ai_pdf_import', 3),
    ('studio', 'ai_short_action', 2000),
    ('studio', 'ai_pdf_import', 15)
) as quota(offer_code, code, limit_value)
join public.offers offer on offer.offer_code = quota.offer_code;

insert into public.client_compatibility_rules (
  id, platform, channel, minimum_supported_version, effective_at, message
)
values
  (
    '91000000-0000-4000-8000-000000000301',
    'windows', 'stable', '0.1.7', '2026-09-12T00:00:00Z',
    'Mettez Scénario à jour pour continuer les services en ligne.'
  ),
  (
    '91000000-0000-4000-8000-000000000302',
    'macos', 'stable', '0.1.7', '2026-09-12T00:00:00Z',
    'Mettez Scénario à jour pour continuer les services en ligne.'
  );
