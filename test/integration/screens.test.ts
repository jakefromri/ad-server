// SCREEN-INT-01..06, APIKEY-INT-01..02. test-plan.md § Integration Tests.

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, registerScreen, jsonRequest, cleanupAll } from '../helpers';

describe('SCREEN-INT', () => {
  afterAll(cleanupAll);

  it('SCREEN-INT-01: registration issues a working device key', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin);
    const screen = await registerScreen(tenant.tenantAdmin);
    expect(screen.status).toBe(201);
    expect(screen.body.device_api_key).toBeTruthy();

    const { status } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(201);
  });

  it('SCREEN-INT-02: revoked device key rejected after rotation', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);
    const oldKey = screen.body.device_api_key;

    const rotate = await jsonRequest(`/v1/screens/${screen.body.screen.id}/rotate-key`, {
      method: 'POST',
      token: tenant.tenantAdmin.token,
    });
    expect(rotate.status).toBe(200);
    expect(rotate.body.device_api_key).not.toBe(oldKey);

    const { status } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: oldKey });
    expect(status).toBe(401);
  });

  it('SCREEN-INT-03: device key cannot access management endpoints', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);
    const { status } = await jsonRequest('/v1/campaigns', { token: screen.body.device_api_key });
    expect(status).toBe(403);
  });

  it('SCREEN-INT-04: one tenant\'s device cannot read another tenant\'s data', async () => {
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();
    await createCampaign(tenantB.tenantAdmin); // matches every targeting criteria by default
    const screenA = await registerScreen(tenantA.tenantAdmin);

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA.body.device_api_key });
    expect(status).toBe(200);
    expect(body.fulfilled).toBe(false);
    expect(body.reason).toBe('no_eligible_campaigns');
  });

  it('SCREEN-INT-05: edit screen — happy path (inactive status is a signal, not an auth gate)', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);

    const patch = await jsonRequest(`/v1/screens/${screen.body.screen.id}`, {
      method: 'PATCH',
      token: tenant.tenantAdmin.token,
      json: { status: 'inactive' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.screen.status).toBe('inactive');

    // Device key still authenticates — status doesn't revoke it in MVP.
    const { status } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect([200, 201]).toContain(status);
  });

  it('SCREEN-INT-06: edit screen — validation error on bad orientation', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);
    const { status } = await jsonRequest(`/v1/screens/${screen.body.screen.id}`, {
      method: 'PATCH',
      token: tenant.tenantAdmin.token,
      json: { orientation: 'sideways' },
    });
    expect(status).toBe(400);
  });
});

describe('APIKEY-INT', () => {
  afterAll(cleanupAll);

  it('APIKEY-INT-01: view and rotate tenant API key — happy path', async () => {
    const tenant = await createTenantFixture();

    const view = await jsonRequest('/v1/tenant/api-key', { token: tenant.tenantAdmin.token });
    expect(view.status).toBe(200);
    expect(view.body.key_prefix).toBeTruthy();
    expect(view.body.key_hash).toBeUndefined();

    const rotate = await jsonRequest('/v1/tenant/api-key/rotate', { method: 'POST', token: tenant.tenantAdmin.token });
    expect(rotate.status).toBe(200);
    expect(rotate.body.api_key).toBeTruthy();
    expect(rotate.body.api_key).not.toBe(tenant.tenantApiKey);

    // Pre-rotation key no longer authenticates.
    const { status } = await jsonRequest('/v1/campaigns', { token: tenant.tenantApiKey });
    expect(status).toBe(401);
  });

  it('APIKEY-INT-02: rotate blocked for a device API key', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);
    const { status } = await jsonRequest('/v1/tenant/api-key/rotate', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(403);
  });
});
