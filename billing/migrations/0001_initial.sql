CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject text NOT NULL UNIQUE,
    stripe_customer_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (length(auth_subject) BETWEEN 1 AND 255),
    CHECK (stripe_customer_id IS NULL OR stripe_customer_id LIKE 'cus\_%' ESCAPE '\')
);

CREATE TABLE subscriptions (
    stripe_subscription_id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stripe_customer_id text NOT NULL,
    status text NOT NULL,
    current_period_end timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    stripe_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (stripe_subscription_id LIKE 'sub\_%' ESCAPE '\'),
    CHECK (stripe_customer_id LIKE 'cus\_%' ESCAPE '\')
);
CREATE INDEX subscriptions_account_status_idx ON subscriptions(account_id, status);

CREATE TABLE stripe_entitlements (
    stripe_customer_id text NOT NULL,
    stripe_entitlement_id text NOT NULL,
    feature_id text NOT NULL,
    lookup_key text NOT NULL,
    livemode boolean NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (stripe_customer_id, lookup_key),
    UNIQUE (stripe_entitlement_id),
    CHECK (stripe_customer_id LIKE 'cus\_%' ESCAPE '\'),
    CHECK (stripe_entitlement_id LIKE 'ent\_%' ESCAPE '\')
);

CREATE TABLE devices (
    id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key bytea NOT NULL,
    public_key_sha256 text NOT NULL,
    display_name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    first_activated_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (account_id, public_key_sha256),
    CHECK (id LIKE 'dmoft-device-v1-%'),
    CHECK (octet_length(public_key) = 32),
    CHECK (length(display_name) BETWEEN 1 AND 80)
);
CREATE INDEX devices_account_status_idx ON devices(account_id, status);

CREATE TABLE checkout_activations (
    stripe_checkout_session_id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    consumed_device_id text REFERENCES devices(id),
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (stripe_checkout_session_id LIKE 'cs\_%' ESCAPE '\')
);

CREATE TABLE license_challenges (
    id uuid PRIMARY KEY,
    purpose text NOT NULL CHECK (purpose IN ('activate', 'enroll', 'refresh')),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stripe_customer_id text NOT NULL,
    checkout_session_id text,
    device_id text NOT NULL,
    device_public_key bytea NOT NULL,
    device_key_sha256 text NOT NULL,
    challenge text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(device_public_key) = 32),
    CHECK ((purpose = 'activate' AND checkout_session_id IS NOT NULL) OR
           (purpose IN ('enroll', 'refresh') AND checkout_session_id IS NULL))
);
CREATE INDEX license_challenges_expiry_idx ON license_challenges(expires_at) WHERE used_at IS NULL;

CREATE TABLE issued_licenses (
    jti uuid PRIMARY KEY,
    challenge_id uuid NOT NULL UNIQUE REFERENCES license_challenges(id),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stripe_customer_id text NOT NULL,
    stripe_subscription_id text NOT NULL,
    device_id text NOT NULL REFERENCES devices(id),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    grace_until timestamptz NOT NULL,
    claims jsonb NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at >= issued_at),
    CHECK (grace_until >= expires_at),
    CHECK (grace_until <= expires_at + interval '7 days')
);
CREATE INDEX issued_licenses_device_expiry_idx ON issued_licenses(device_id, expires_at DESC);

CREATE TABLE stripe_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    event_created_at timestamptz NOT NULL,
    livemode boolean NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    received_at timestamptz NOT NULL DEFAULT now(),
    processing_started_at timestamptz,
    processed_at timestamptz,
    CHECK (event_id LIKE 'evt\_%' ESCAPE '\')
);
CREATE INDEX stripe_events_status_idx ON stripe_events(status, received_at);

CREATE TABLE api_rate_limits (
    bucket_key text NOT NULL,
    window_start bigint NOT NULL,
    request_count integer NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_key, window_start),
    CHECK (request_count > 0)
);
CREATE INDEX api_rate_limits_expiry_idx ON api_rate_limits(expires_at);
