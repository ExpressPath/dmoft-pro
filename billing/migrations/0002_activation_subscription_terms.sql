ALTER TABLE checkout_activations
    ADD COLUMN stripe_subscription_id text,
    ADD COLUMN terms_version text,
    ADD COLUMN terms_accepted_at timestamptz;

ALTER TABLE checkout_activations
    ADD CONSTRAINT checkout_activations_subscription_id_check
        CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id LIKE 'sub\_%' ESCAPE '\'),
    ADD CONSTRAINT checkout_activations_terms_version_check
        CHECK (terms_version IS NULL OR length(terms_version) BETWEEN 1 AND 64);

ALTER TABLE license_challenges
    ADD COLUMN stripe_subscription_id text,
    ADD COLUMN terms_version text;

ALTER TABLE license_challenges
    ADD CONSTRAINT license_challenges_subscription_id_check
        CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id LIKE 'sub\_%' ESCAPE '\'),
    ADD CONSTRAINT license_challenges_terms_version_check
        CHECK (terms_version IS NULL OR length(terms_version) BETWEEN 1 AND 64),
    ADD CONSTRAINT license_challenges_activation_context_check
        CHECK (
            (purpose = 'activate' AND stripe_subscription_id IS NOT NULL AND terms_version IS NOT NULL)
            OR (purpose IN ('enroll', 'refresh') AND stripe_subscription_id IS NULL AND terms_version IS NULL)
        ) NOT VALID;
