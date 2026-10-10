/**
 * SpellProjectile — projectile spell categories.
 *
 * Projectile spawn, velocity and hits are server-authoritative (the
 * server creates the SpellProjectile objects); the client renders them.
 *
 * Reference: ACE SpellProjectile.cs, Player_Magic.cs
 */

// ─── Projectile Spell Type ─────────────────────────────────

/** How a spell projectile behaves */
export enum ProjectileSpellType {
  Undef   = 0,
  Bolt    = 1,    // Single tracking projectile (default)
  Blast   = 2,    // Multi-projectile burst from caster (AoE)
  Volley  = 3,    // Multi-projectile spread pattern
  Streak  = 4,    // Single fast-moving streak
  Arc     = 5,    // Single non-tracking ballistic arc
  Ring    = 6,    // Multi-projectile 360° ring
  Wall    = 7,    // Line of projectiles forming a wall
  Strike  = 8,    // Appears at target location
}
