// ACE physics harness (tools/ace-physics-harness/run.sh): builds caster, target, door and projectile PhysicsObjs from
// the live ACE image's own ACE.Server.dll over our DATs, places them with enter_world, launches a bolt with ACE's
// spawn maths (WorldObject_Magic.CalculatePreOffset / CalculateProjectileOrigins / CalculateProjectileVelocity, copied
// below for one bolt), runs IsProjectileVisible and update_object ticks, and records what OnCollideObject /
// OnCollideEnvironment saw (Harmony prefixes; the WorldObjects are bare shells, so no game logic runs).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Runtime.CompilerServices;
using HarmonyLib;
using System.Threading.Tasks;
using ACE.DatLoader;
using ACE.Entity;
using ACE.Entity.Enum;
using ACE.Entity.Enum.Properties;
using ACE.Server.Entity;
using ACE.Server.Managers;
using ACE.Server.Physics;
using ACE.Server.Physics.Animation;
using ACE.Server.Physics.Common;
using ACE.Server.WorldObjects;
using PPos = ACE.Server.Physics.Common.Position;

static class Rec {
  public static List<string> Events = new();
}

static class Patches {
  public static bool Skip() => false;
  public static bool ProjObj(WorldObject __instance, WorldObject __0) { var target = __0;
    Rec.Events.Add($"OnCollideObject(proj={(__instance is SpellProjectile)} target={(target is Creature ? "creature" : "?")} tguid={target?.Guid.Full:X8})");
    return false;
  }
  public static bool ProjEnv(WorldObject __instance) { Rec.Events.Add($"OnCollideEnvironment(proj={(__instance is SpellProjectile)})"); return false; }
}

class Program {
  static bool Verbose;
  static bool FollowFloor;
  static Vector3 TargetVel = Vector3.Zero;
  static uint siteCell;
  static Dictionary<string, Vector3> siteCache = new();
  static void V(string m) { if (Verbose) Console.WriteLine(m); }
  static uint nextGuid = 0x80001000;
  static T Uninit<T>() {
    var o = (T)RuntimeHelpers.GetUninitializedObject(typeof(T));
    typeof(WorldObject).GetField("<Biota>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(o, new ACE.Entity.Models.Biota());
    typeof(WorldObject).GetField("BiotaDatabaseLock", BindingFlags.Public | BindingFlags.Instance).SetValue(o, new System.Threading.ReaderWriterLockSlim());
    return o;
  }
  static WeenieObject Weenie(WorldObject wo) {
    var w = new WeenieObject();
    var info = (WorldObjectInfo)RuntimeHelpers.GetUninitializedObject(typeof(WorldObjectInfo));
    typeof(WorldObjectInfo).GetField("WorldObjectRef").SetValue(info, new WeakReference<WorldObject>(wo));
    typeof(WeenieObject).GetField("WorldObjectInfo").SetValue(w, info);
    return w;
  }
  static List<object> keep = new();
  static PhysicsObj Creature(uint setup, float scale, WorldObject wo, PhysicsState state) {
    keep.Add(wo);
    var p = new PhysicsObj();
    p.makeAnimObject(setup, true);
    var g = new ObjectGuid(nextGuid++);
    // guid on the uninitialized WorldObject
    SetGuid(wo, g);
    p.set_object_guid(g);
    p.set_weenie_obj(Weenie(wo));
    p.SetScaleStatic(scale);
    p.State = state;
    SetPhys(wo, p);
    return p;
  }
  static void SetPhys(WorldObject wo, PhysicsObj p) {
    typeof(WorldObject).GetProperty("PhysicsObj").GetSetMethod(true).Invoke(wo, new object[] { p });
  }
  static void SetGuid(WorldObject wo, ObjectGuid g) {
    var f = typeof(WorldObject).GetField("<Guid>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance);
    f.SetValue(wo, g);
  }
  static void Tick(double dt) {
    var prop = typeof(Timers).GetProperty("PortalYearTicks");
    prop.SetValue(null, Timers.PortalYearTicks + dt);
  }

  static void Main(string[] args) {
    try { Run(args); } catch (Exception e) { Console.WriteLine(e); } Environment.Exit(0);
  }
  static void Run(string[] args) {
    log4net.Config.BasicConfigurator.Configure(new log4net.Appender.ConsoleAppender { Threshold = log4net.Core.Level.Warn, Layout = new log4net.Layout.SimpleLayout() });
    System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
    DatManager.Initialize("/dat", true);
    var pe = new PhysicsEngine(new ObjectMaint(), new SmartBox()); pe.Server = true;
    TaskScheduler.UnobservedTaskException += (s2, e2) => e2.SetObserved();
    // cache properties that physics reads
    var cacheObj = typeof(PropertyManager).GetField("CachedBooleanSettings", BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Public).GetValue(null);
    var ceType = typeof(PropertyManager).Assembly.GetTypes().First(t => t.Name == "ConfigurationEntry`1").MakeGenericType(typeof(bool));
    var entry = Activator.CreateInstance(ceType, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, new object[] { true, false, "" }, null);
    cacheObj.GetType().GetProperty("Item").SetValue(cacheObj, entry, new object[] { "spell_projectile_ethereal" });

    var h = new Harmony("pb");
    var pre = new HarmonyMethod(typeof(Patches).GetMethod("Skip"));
    foreach (var t in typeof(WorldObject).Assembly.GetTypes().Where(t => typeof(WorldObject).IsAssignableFrom(t))) {
      foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly)) {
        if (m.IsAbstract) continue;
        if (m.Name == "OnCollideObject" && m.GetParameters().Length == 1) h.Patch(m, new HarmonyMethod(typeof(Patches).GetMethod("ProjObj")));
        else if (m.Name == "OnCollideEnvironment" && m.GetParameters().Length == 0) h.Patch(m, new HarmonyMethod(typeof(Patches).GetMethod("ProjEnv")));
        else if (m.Name == "OnCollideObjectEnd") h.Patch(m, pre);
      }
    }
    foreach (var m in typeof(WorldObject).GetMethods().Where(m => m.Name == "SetProperty" || m.Name == "SyncLocation")) h.Patch(m, pre);

    var mode = args.Length > 0 ? args[0] : "sweep";
    var tvEnv = Environment.GetEnvironmentVariable("TV");
    if (!string.IsNullOrEmpty(tvEnv)) { var a = tvEnv.Split(',').Select(float.Parse).ToArray(); TargetVel = new Vector3(a[0], a[1], a[2]); Console.WriteLine($"target velocity (caster frame: +Y toward caster? no: +Y away from caster) {TargetVel}"); }
    if (mode == "cell") {
      var id = Convert.ToUInt32(args[1], 16);
      var lc = LScape.get_landcell(id);
      Console.WriteLine($"landcell {lc?.GetType().Name} id={lc?.ID:X8}");
      var env = lc as ACE.Server.Physics.Common.EnvCell;
      Console.WriteLine($"pos={env?.Pos.Frame.Origin} rot={env?.Pos.Frame.Orientation}");
      for (var dz = -3f; dz <= 3f; dz += 0.5f) {
        var pt = env.Pos.Frame.Origin + new Vector3(0, 0, dz);
        Console.WriteLine($" dz={dz} in={env.point_in_cell(pt)}");
      }
      return;
    }
    if (mode == "stairs") {
      // args: lb setup scale x y [x y ...]: caster at each x,y on its floor; target along bearings, following the floor
      FollowFloor = true;
      var lb = Convert.ToUInt32(args[1], 16); var setupS = Convert.ToUInt32(args[2], 16); var scaleS = float.Parse(args[3]);
      for (var i = 4; i + 1 < args.Length; i += 2) {
        var x = float.Parse(args[i]); var y = float.Parse(args[i + 1]);
        foreach (var lvl in Column(lb, x, y)) {
          if (lvl.lo > 5) continue;
          siteCache["X"] = new Vector3(x, y, lvl.lo); siteCell = lvl.cell;
          Console.WriteLine($"== caster ({x},{y}) cell {lvl.cell:X8} floor {lvl.lo:0.00}");
          foreach (var b in new[] { -30f, 0f, 30f, 150f, 180f, 210f })
            foreach (var d in new[] { 1.2f, 1.4f, 1.6f, 1.8f, 2.0f, 2.5f, 3.0f, 4.0f, 5.0f }) {
              var r = Shot(setupS, scaleS, d, b, "X");
              Console.WriteLine($"  brg={b,4} D={d:0.0} {(r.Contains("OnCollideObject") ? "HIT " : "MISS")} {r}");
            }
        }
      }
      return;
    }
    if (mode == "door") {
      // args: lb cx cy tx ty [doorOpen]
      var lb = Convert.ToUInt32(args[1], 16);
      float cx = float.Parse(args[2]), cy = float.Parse(args[3]), tx = float.Parse(args[4]), ty = float.Parse(args[5]);
      var withDoor = args.Length <= 6 || args[6] != "nodoor";
      var dWo = Uninit<Door>(); keep.Add(dWo);
      var door = PhysicsObj.makeObject(0x0200024F, 0x70145010, true);
      SetGuid(dWo, new ObjectGuid(0x70145010)); door.set_object_guid(new ObjectGuid(0x70145010)); door.set_weenie_obj(Weenie(dWo)); SetPhys(dWo, door);
      door.State = PhysicsState.ReportCollisions | PhysicsState.IgnoreCollisions | (door.State & PhysicsState.HasPhysicsBSP);
      Console.WriteLine($"door state {door.State} parts {door.PartArray?.NumParts}");
      if (withDoor) {
        var dpos = new PPos(0x0145010D, new AFrame(new Vector3(100f, -34.75f, -6f), new Quaternion(0, 0, -1, 0)));
        door.Position.ObjCellID = 0x0145010D;
        Console.WriteLine($"door enter {door.enter_world(dpos)} cell {door.CurCell?.ID:X8}");
      }
      var cf = FloorAt(lb, cx, cy, 0f) ?? throw new Exception("no caster floor");
      var tf = FloorAt(lb, tx, ty, cf.z + 0.3f) ?? throw new Exception("no target floor");
      siteCache["X"] = new Vector3(cx, cy, cf.z); siteCell = cf.cell;
      TargetOverride = (tf.cell, new Vector3(tx, ty, tf.z));
      Verbose = true;
      var dd = MathF.Sqrt((tx - cx) * (tx - cx) + (ty - cy) * (ty - cy));
      Console.WriteLine($"caster ({cx},{cy},{cf.z:0.0}) target ({tx},{ty},{tf.z:0.0}) D={dd:0.00}: {Shot(0x02000059, 1f, dd, 0, "X")}");
      return;
    }
    if (mode == "grid") {
      // caster on each floor point in [cx0,cx1]x[cy0,cy1]; target on every floor point within rmin..rmax; report misses
      FollowFloor = false;
      var lb = Convert.ToUInt32(args[1], 16); var setupS = Convert.ToUInt32(args[2], 16); var scaleS = float.Parse(args[3]);
      float cx0 = float.Parse(args[4]), cx1 = float.Parse(args[5]), cy0 = float.Parse(args[6]), cy1 = float.Parse(args[7]);
      float rmax = float.Parse(args[8]); float st = 0.5f;
      int hits = 0, misses = 0;
      var missByD = new SortedDictionary<int, (int h, int m)>();
      for (var cx = cx0; cx <= cx1 + 1e-3; cx += st) for (var cy = cy0; cy <= cy1 + 1e-3; cy += st)
      foreach (var cl in Column(lb, cx, cy).Where(c => c.lo < 4)) {
        for (var tx = cx - rmax; tx <= cx + rmax + 1e-3; tx += st) for (var ty = cy - rmax; ty <= cy + rmax + 1e-3; ty += st) {
          var dd = MathF.Sqrt((tx - cx) * (tx - cx) + (ty - cy) * (ty - cy));
          if (dd < 1.0f || dd > rmax) continue;
          foreach (var tl in Column(lb, tx, ty).Where(c => c.lo < 4 && MathF.Abs(c.lo - cl.lo) < 3.0f)) {
            TargetOverride = (tl.cell, new Vector3(tx, ty, tl.lo));
            siteCache["X"] = new Vector3(cx, cy, cl.lo); siteCell = cl.cell;
            var r = Shot(setupS, scaleS, dd, 0, "X");
            TargetOverride = null;
            if (!r.Contains("realD")) continue;
            var hit = r.Contains("OnCollideObject");
            var key = (int)MathF.Round(dd);
            missByD.TryGetValue(key, out var e); missByD[key] = hit ? (e.h + 1, e.m) : (e.h, e.m + 1);
            if (hit) hits++; else { misses++; Console.WriteLine($"MISS c=({cx},{cy},{cl.lo:0.0}) t=({tx},{ty},{tl.lo:0.0}) D={dd:0.00} :: {r}"); }
          }
        }
      }
      foreach (var kv in missByD) Console.WriteLine($"D~{kv.Key}: hits {kv.Value.h} misses {kv.Value.m}");
      return;
    }
    if (mode == "hmap") {
      var lb = Convert.ToUInt32(args[1], 16);
      float x0 = float.Parse(args[2]), x1 = float.Parse(args[3]), y0 = float.Parse(args[4]), y1 = float.Parse(args[5]), st = float.Parse(args[6]);
      Console.Write("      ");
      for (var x = x0; x <= x1 + 1e-3; x += st) Console.Write($"{x,6:0.0}");
      Console.WriteLine();
      for (var y = y1; y >= y0 - 1e-3; y -= st) {
        Console.Write($"{y,6:0.0}");
        for (var x = x0; x <= x1 + 1e-3; x += st) {
          var col = Column(lb, x, y).Where(c => c.lo < 4).Select(c => c.lo).OrderBy(z => z).ToList();
          Console.Write(col.Count == 0 ? "     ." : $"{string.Join("/", col.Select(z => z.ToString("0.0"))),6}");
        }
        Console.WriteLine();
      }
      return;
    }
    if (mode == "probe") {
      var lb = Convert.ToUInt32(args[1], 16);
      var info = DatManager.CellDat.ReadFromDat<ACE.DatLoader.FileTypes.LandblockInfo>((lb << 16) | 0xFFFE);
      for (var i = 2; i + 1 < args.Length; i += 2) {
        var x = float.Parse(args[i]); var y = float.Parse(args[i + 1]);
        Console.WriteLine($"-- column ({x},{y})");
        for (uint c = 0x100; c < 0x100 + info.NumCells; c++) {
          var env = LScape.get_landcell((lb << 16) | c) as ACE.Server.Physics.Common.EnvCell;
          if (env == null) continue;
          float? lo = null, hi = null;
          for (var z = -30f; z <= 20f; z += 0.1f) if (env.point_in_cell(new Vector3(x, y, z))) { lo ??= z; hi = z; }
          if (lo != null) Console.WriteLine($"  cell {(lb << 16) | c:X8} z {lo:0.0}..{hi:0.0}");
        }
      }
      return;
    }
    if (mode == "scan") {
      var lb = Convert.ToUInt32(args[1], 16);
      var setupS = Convert.ToUInt32(args[2], 16); var scaleS = float.Parse(args[3]);
      var info = DatManager.CellDat.ReadFromDat<ACE.DatLoader.FileTypes.LandblockInfo>((lb << 16) | 0xFFFE);
      Console.WriteLine($"numcells {info.NumCells:X}");
      var rnd = new Random(7);
      int nearMissFarHit = 0, nearMiss = 0, nearHit = 0, configs = 0;
      for (uint c = 0x100; c < 0x100 + info.NumCells; c += 1) {
        var cellId = (lb << 16) | c;
        var env = LScape.get_landcell(cellId) as ACE.Server.Physics.Common.EnvCell;
        if (env == null) continue;
        var pts = new List<Vector3>();
        for (var x = -12f; x <= 12f; x += 1f) for (var y = -12f; y <= 12f; y += 1f) for (var z = -8f; z <= 8f; z += 0.5f) {
          var pt = env.Pos.Frame.Origin + new Vector3(x, y, z);
          if (env.point_in_cell(pt)) pts.Add(pt);
        }
        if (pts.Count == 0) continue;
        var minZ = pts.Min(q => q.Z);
        var floor = pts.Where(q => q.Z < minZ + 0.6f).ToList();
        for (var k = 0; k < Math.Min(3, floor.Count); k++) {
          var o = floor[rnd.Next(floor.Count)];
          siteCache["X"] = o; siteCell = cellId;
          for (var b = 0; b < 360; b += 30) {
            var res = new Dictionary<float, (bool hit, bool valid, string r)>();
            foreach (var d in new[] { 1.4f, 1.6f, 1.9f, 2.4f, 3.0f, 4.0f }) {
              var r = Shot(setupS, scaleS, d, b, "X");
              var hit = r.Contains("OnCollideObject");
              var valid = r.Contains("realD=") && !r.Contains("setup failed");
              res[d] = (hit, valid, r);
            }
            // a config counts when the far shots (3, 4 m) hit, i.e. the line is open, and the target sits where we asked
            if (!res[3.0f].hit || !res[4.0f].hit) continue;
            configs++;
            foreach (var d in new[] { 1.4f, 1.6f, 1.9f, 2.4f }) {
              if (!res[d].valid) continue;
              if (res[d].hit) nearHit++; else { nearMiss++; Console.WriteLine($"MISS cell={cellId:X8} o={o} brg={b} D={d} :: {res[d].r}"); }
            }
          }
        }
      }
      Console.WriteLine($"configs(far shots hit)={configs} near hits={nearHit} near misses={nearMiss}");
      return;
    }
    if (mode == "one") { Verbose = true; Console.WriteLine(Shot(Convert.ToUInt32(args[2], 16), float.Parse(args[3]), float.Parse(args[4]), float.Parse(args[5]), args[1])); return; }
    var site = args.Length > 1 ? args[1] : "out";
    foreach (var (name, setup, scale) in new[] { ("skeleton", 0x02000059u, 1.0f), ("armoredillo", 0x02000004u, 0.8f) }) {
      Console.WriteLine($"== {name} at {site}");
      for (var d = 0.6f; d <= 3.51f; d += 0.1f) {
        foreach (var bearing in new[] { 0f, 37f, 90f, 200f }) {
          var r = Shot(setup, scale, d, bearing, site);
          Console.WriteLine($"{name} D={d:0.0} brg={bearing,3} {r}"); Console.Out.Flush();
        }
      }
    }
  }

  static List<(uint cell, float lo, float hi)> Column(uint lb, float x, float y) {
    var info = DatManager.CellDat.ReadFromDat<ACE.DatLoader.FileTypes.LandblockInfo>((lb << 16) | 0xFFFE);
    var res = new List<(uint, float, float)>();
    for (uint c = 0x100; c < 0x100 + info.NumCells; c++) {
      var env = LScape.get_landcell((lb << 16) | c) as ACE.Server.Physics.Common.EnvCell;
      if (env == null) continue;
      float? lo = null, hi = null;
      for (var z = -30f; z <= 20f; z += 0.05f) if (env.point_in_cell(new Vector3(x, y, z))) { lo ??= z; hi = z; }
      if (lo != null) res.Add(((lb << 16) | c, lo.Value, hi.Value));
    }
    return res;
  }
  // floor (cell, z) at x,y just below `nearZ`
  static (uint cell, float z)? FloorAt(uint lb, float x, float y, float nearZ) {
    var col = Column(lb, x, y).Where(c => c.lo <= nearZ + 0.6f).OrderByDescending(c => c.lo).ToList();
    if (col.Count == 0) return null;
    return (col[0].cell, col[0].lo);
  }
  public static (uint cell, Vector3 pos)? TargetOverride;
  static (uint cell, Vector3 pos) Site(string site) {
    if (site == "out") {
      // Holtburg fields: landblock A9B4, open ground
      var p = new ACE.Entity.Position(0xA9B40019, 84f, 84f, 100f, 0, 0, 0, 1);
      var z = p.GetTerrainZ();
      return (0xA9B40000 | 0x19, new Vector3(84f, 84f, z));
    } else {
      if (site == "X") return (siteCell, siteCache["X"]);
      var cellId = Convert.ToUInt32(site, 16);
      if (siteCache.TryGetValue(site, out var c)) return (cellId, c);
      var env = (ACE.Server.Physics.Common.EnvCell)LScape.get_landcell(cellId);
      var pts = new List<Vector3>();
      for (var x = -15f; x <= 15f; x += 0.5f) for (var y = -15f; y <= 15f; y += 0.5f) for (var z = -6f; z <= 6f; z += 0.5f) {
        var pt = env.Pos.Frame.Origin + new Vector3(x, y, z);
        if (env.point_in_cell(pt)) pts.Add(pt);
      }
      var minZ = pts.Min(q => q.Z);
      var floor = pts.Where(q => q.Z < minZ + 0.6f).ToList();
      var cen = new Vector3(floor.Average(q => q.X), floor.Average(q => q.Y), minZ);
      Console.WriteLine($"cell {cellId:X8}: {pts.Count} pts, floor pts {floor.Count}, centre {cen}, x[{floor.Min(q=>q.X)},{floor.Max(q=>q.X)}] y[{floor.Min(q=>q.Y)},{floor.Max(q=>q.Y)}]");
      siteCache[site] = cen;
      return (cellId, cen);
    }
  }

  static string Shot(uint setup, float scale, float d, float bearingDeg, string site) {
    Rec.Events.Clear();
    var (cell, origin) = Site(site);
    var casterWo = Uninit<Player>();
    var targetWo = Uninit<Creature>();
    var caster = Creature(0x02000001, 1.0f, casterWo, PhysicsState.ReportCollisions | PhysicsState.Gravity | PhysicsState.EdgeSlide);
    var target = Creature(setup, scale, targetWo, PhysicsState.ReportCollisions | PhysicsState.Gravity);
    var rad = bearingDeg * MathF.PI / 180f;
    var dir = new Vector3(MathF.Sin(rad), MathF.Cos(rad), 0);
    var cpos = new PPos(cell, new AFrame(origin + new Vector3(0, 0, 0.05f), Quaternion.Identity));
    var tpos = new PPos(cell, new AFrame(origin + dir * d + new Vector3(0, 0, 0.05f), Quaternion.Identity));
    if (TargetOverride != null) {
      tpos = new PPos(TargetOverride.Value.cell, new AFrame(TargetOverride.Value.pos + new Vector3(0, 0, 0.05f), Quaternion.Identity));
      target.Position.ObjCellID = TargetOverride.Value.cell;
    }
    if (FollowFloor) {
      var tp = origin + dir * d;
      var f = FloorAt(cell >> 16, tp.X, tp.Y, origin.Z + 0.3f);
      if (f == null) return "no floor for target";
      tpos = new PPos(f.Value.cell, new AFrame(new Vector3(tp.X, tp.Y, f.Value.z + 0.05f), Quaternion.Identity));
      target.Position.ObjCellID = f.Value.cell;
    }
    caster.Position.ObjCellID = cell; target.Position.ObjCellID = cell;
    var okC = caster.enter_world(cpos);
    var okT = target.enter_world(tpos);
    if (!okC || !okT) { Cleanup(caster, target, null); return $"setup failed caster={okC} target={okT}"; }
    Rec.Events.Clear();
    V($"caster cell={caster.CurCell?.ID:X8} pos={caster.Position.Frame.Origin} contact={caster.TransientState}");
    V($"target cell={target.CurCell?.ID:X8} pos={target.Position.Frame.Origin}");
    var realD = (target.Position.Frame.Origin - caster.Position.Frame.Origin);
    var realDist = new Vector2(realD.X, realD.Y).Length();

    // ---- ACE CalculatePreOffset / CalculateProjectileOrigins / Velocity (Bolt, one projectile, CreateOffset 0) ----
    const float ProjHeight = 2.0f / 3.0f;
    var projRadius = 0.1f; // setup 0x0200040D spheres[0].Radius * scale 1
    var startPos = new PPos(caster.Position); startPos.Frame.Origin.Z += caster.GetHeight() * ProjHeight;
    var endPos = new PPos(target.Position); endPos.Frame.Origin.Z += target.GetHeight() * ProjHeight;
    var globOffset = startPos.GetOffset(endPos);
    var rotateA = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, (float)Math.Atan2(globOffset.X, globOffset.Y));
    var localDir = Vector3.Normalize(Vector3.Transform(globOffset, rotateA));
    var radsumPre = caster.GetPhysicsRadius() + projRadius;
    var preOffset = new Vector3(0, 0, caster.GetHeight() * ProjHeight) + (localDir * radsumPre - Vector3.UnitY * radsumPre);
    var radsum = caster.GetPhysicsRadius() * 2.0f + projRadius * 2.0f;
    var cylDist = (float)PPos.CylinderDistance(caster.GetRadius(), caster.GetHeight(), caster.Position, target.GetRadius(), target.GetHeight(), target.Position);
    if (cylDist < 0.6f) radsum = caster.GetPhysicsRadius() + projRadius;
    var baseOffset = new Vector3(0, radsum, 0) + preOffset;
    var qDir = caster.Position.GetOffset(target.Position);
    var rotate = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, (float)Math.Atan2(-qDir.X, qDir.Y));
    var spawn = caster.Position.Frame.Origin + Vector3.Transform(baseOffset, rotate);
    var aim = target.Position.Frame.Origin + new Vector3(0, 0, target.GetHeight() * ProjHeight);
    var vel = Vector3.Normalize(aim - spawn) * 15f;
    if (TargetVel != Vector3.Zero) {
      // ACE CalculateProjectileVelocity, IsTracking: lateral ballistic solve against the target's CachedVelocity (gravity 0)
      var tv = Vector3.Transform(TargetVel, rotate);
      if (ACE.Server.Physics.Trajectory.solve_ballistic_arc_lateral(spawn, 15f, aim, tv, 0f, out var fv, out var tt, out var ip) && fv != Vector3.Zero) vel = fv;
      V($"tracking: tv={tv} vel={vel}");
    }

    // ---- projectile ----
    var spWo = Uninit<SpellProjectile>(); keep.Add(spWo);
    var sp = PhysicsObj.makeObject(0x0200040D, nextGuid, true);
    var g = new ObjectGuid(nextGuid++); SetGuid(spWo, g);
    sp.set_object_guid(g);
    sp.set_weenie_obj(Weenie(spWo));
    SetPhys(spWo, sp);
    sp.State = PhysicsState.ReportCollisions | PhysicsState.Missile | PhysicsState.AlignPath | PhysicsState.PathClipped | PhysicsState.LightingOn | PhysicsState.Inelastic;
    var spPos = new PPos(cell, new AFrame(spawn, Quaternion.Identity));
    sp.Position.Frame.Origin = spawn;
    sp.Velocity = vel;
    sp.ProjectileTarget = target;
    sp.Position.Frame.set_vector_heading(Vector3.Normalize(vel));
    spPos.Frame.Orientation = sp.Position.Frame.Orientation;
    sp.set_active(true);
    sp.Position.ObjCellID = cell;
    var entered = sp.enter_world(spPos);
    var entryEvents = string.Join(";", Rec.Events); Rec.Events.Clear();
    var gap = Vector3.Distance(spawn, target.Position.Frame.Origin);
    var info = $"realD={realDist:0.00} dz={(target.Position.Frame.Origin.Z - caster.Position.Frame.Origin.Z):0.00} cylDist={cylDist:0.00} spawnAhead={new Vector2(spawn.X - caster.Position.Frame.Origin.X, spawn.Y - caster.Position.Frame.Origin.Y).Length():0.00} z={(spawn.Z - caster.Position.Frame.Origin.Z):0.00}";
    if (!entered) { Cleanup(caster, target, sp); return $"{info} | ENTRY FAILED events=[{entryEvents}]"; }
    if (entryEvents.Length > 0) { Cleanup(caster, target, sp); return $"{info} | entry collision [{entryEvents}]"; }
    // IsProjectileVisible (caster is a Creature, not ethereal)
    var vStart = new PPos(sp.Position); var vTarget = new PPos(caster.Position);
    vTarget.Frame.Origin.Z += caster.GetHeight() - sp.GetHeight();
    var prevT = sp.ProjectileTarget; sp.ProjectileTarget = caster;
    var tr = sp.transition(vStart, vTarget, false);
    sp.ProjectileTarget = prevT;
    V($"spawn={spawn} vel={vel} spCell={sp.CurCell?.ID:X8} spPos={sp.Position.Frame.Origin}");
    if (tr != null) V($"vis: objs=[{string.Join(",", tr.CollisionInfo.CollideObject.Select(c => c.ID.ToString("X8")))}] env={tr.CollisionInfo.CollidedWithEnvironment} curpos={tr.SpherePath.CurPos.Frame.Origin} cell={tr.SpherePath.CurPos.ObjCellID:X8}"); else V("vis: transition null");
    var visible = tr != null && tr.CollisionInfo.CollideObject.Any(c => c.ID == caster.ID);
    if (!visible) { Cleanup(caster, target, sp); return $"{info} | NOT VISIBLE -> OnCollideEnvironment (silent)"; }
    // fly
    sp.UpdateTime = PhysicsTimer.CurrentTime;
    var flown = 0.0;
    var start = sp.Position.Frame.Origin;
    for (var i = 0; i < 90 && Rec.Events.Count == 0; i++) {
      Tick(1.0 / 30.0 + 0.0001); flown += 1.0 / 30.0;
      sp.update_object();
      if (sp.CurCell == null) { Rec.Events.Add("left world"); break; }
    }
    var ev = string.Join(";", Rec.Events);
    var moved = Vector3.Distance(start, sp.Position.Frame.Origin);
    Cleanup(caster, target, sp);
    return $"{info} | flight {flown:0.00}s moved {moved:0.00} m -> [{(ev.Length > 0 ? ev : "nothing")}]";
  }

  static void Cleanup(PhysicsObj a, PhysicsObj b, PhysicsObj c) {
    foreach (var p in new[] { a, b, c }) { if (p == null) continue; try { p.leave_world(); } catch { } try { p.DestroyObject(); } catch { } }
  }
}
