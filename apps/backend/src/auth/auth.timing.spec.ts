// Timing side-channel guard for login.
//
// A login attempt for an ID that does not exist must cost the same bcrypt work
// as a wrong password on an account that does. Before this guard the unknown-ID
// path compared against a hand-written `$2b$10$...` hash while register() stores
// cost-12 hashes, so a missing account answered ~4x faster and the whole user
// table could be enumerated from response times alone.
//
// NOTE ON ORDER: the equaliser hash is built once per process and cached at
// module level. This suite therefore runs against a single service instance and
// relies on declaration order: the first test pays for the hash, later tests
// assert that it is NOT rebuilt. Keep new "hash was built" expectations in the
// first test or they will read a warm cache.

import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const compare = bcrypt.compare as jest.MockedFunction<typeof bcrypt.compare>;
const hash = bcrypt.hash as jest.MockedFunction<typeof bcrypt.hash>;

function user(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    restaurantId: 'r1',
    name: 'Owner',
    roleId: 'role1',
    email: 'owner@example.com',
    phone: null,
    isActive: true,
    passwordHash: '$2b$12$stored-hash',
    twoFactorEnabled: false,
    role: { name: 'OWNER', permissions: [] },
    permissionOverrides: [],
    ...over,
  };
}

function build(candidates: unknown[]) {
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue(candidates),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('token') };
  const svc = new AuthService(prisma as never, jwt as never, {
    verifyLogin: jest.fn(),
  } as never);
  return { svc, prisma };
}

/**
 * A rejected login must be a 401 with the neutral message. Asserted on the
 * payload, not on the class identity, so the same expectation holds whether
 * the exception object came from this module instance or another.
 */
async function expectUnauthorized(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({
    status: 401,
    message: 'Invalid login ID or password',
  });
}

// Mock returns are (re)installed per test; call counts are cleared per test but
// the module-level hash cache deliberately survives, which is the point.
beforeEach(() => {
  compare.mockClear();
  hash.mockClear();
  compare.mockResolvedValue(false as never);
  hash.mockResolvedValue('$2b$12$dummy' as never);
});

describe('login timing equaliser', () => {
  it('costs one compare for an unknown email, and builds the hash at cost 12', async () => {
    const { svc } = build([]);
    await expectUnauthorized(
      svc.login({ email: 'ghost@example.com', password: 'x' } as never),
    );
    expect(compare).toHaveBeenCalledTimes(1);
    // The equaliser must be hashed at the same cost register() stores with.
    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash.mock.calls[0][1]).toBe(12);
  });

  it('costs the same one compare for a known email with a wrong password', async () => {
    const { svc } = build([user()]);
    await expectUnauthorized(
      svc.login({ email: 'owner@example.com', password: 'wrong' } as never),
    );
    expect(compare).toHaveBeenCalledTimes(1);
    // the real check already paid; the equaliser must not add a second one
    expect(hash).toHaveBeenCalledTimes(0);
  });

  it('reuses the cached hash instead of re-hashing on every failed attempt', async () => {
    const { svc } = build([]);
    await expectUnauthorized(
      svc.login({ email: 'ghost@example.com', password: 'x' } as never),
    );
    await expectUnauthorized(
      svc.login({ email: 'other@example.com', password: 'y' } as never),
    );
    expect(compare).toHaveBeenCalledTimes(2);
    expect(hash).toHaveBeenCalledTimes(0); // warm from the first test
  });

  it('never compares against the old hand-written fake hash', async () => {
    const { svc } = build([]);
    await expectUnauthorized(
      svc.login({ email: 'ghost@example.com', password: 'x' } as never),
    );
    const usedHash = compare.mock.calls[0][1] as string;
    expect(usedHash).not.toContain('invalidinvalid');
    expect(compare.mock.calls[0][0]).toBe('x');
  });
});

describe('phone login timing', () => {
  it('pads a too-short number to one compare instead of returning instantly', async () => {
    const { svc } = build([]);
    await expectUnauthorized(
      svc.login({ email: '12345', password: 'x' } as never),
    );
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('compares only the digit-exact candidate, adding no extra padding', async () => {
    const { svc } = build([
      user({ phone: '+306900000001' }),
      user({ id: 'u2', phone: '+306900000002' }),
    ]);
    await expectUnauthorized(
      svc.login({ email: '+306900000001', password: 'wrong' } as never),
    );
    expect(compare).toHaveBeenCalledTimes(1);
  });
});
