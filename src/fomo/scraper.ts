import type { BrowserContext, Page, Response } from 'playwright';
import { openContext, hasSession, FOMO_ORIGIN, isFomoApi } from './session.js';
import { probeAuth } from './auth.js';
import { parseLeaderboardResult, parseHodlersTopResult, ROBINHOOD_NETWORK_ID } from './api.js';
import { harvest } from './extract.js';
import { db, setHealth } from '../db.js';
import { links } from '../config.js';
import { log } from '../logger.js';
import type { FomoProvider, FomoLeader, FomoTokenStats, FomoTopHolder } from './provider.js';
import type { PlatformPnl } from '../engine/enrich.js';

/**
 * 全平台 24H 收益**默认开启**。
 *
 * 代价是实测的：Top10 每个人要单独逛一次档案页，十个人约 71 秒。
 * 所以它只在**复核**阶段取（见 engine 的 enrich），初值路径不碰——
 * 开在初值上实测把 +0.8s 预算撑到 1m11s。复核因此从 5m1s 变成约 5m56s。
 *
 * 设 `FOMO_PLATFORM_PNL=0` 可关掉，关掉后该字段显示 n/a，
 * 绝不用「该币累计收益」顶替（两者同一时刻能反号，见 docs/FIELDS.md §2.1）。
 */
const PLATFORM_PNL_ENABLED = process.env.FOMO_PLATFORM_PNL !== '0';
const DAY_SEC = 86_400;
/** 关键业务接口超过这么久没成功，就认为数据源已经不可用。 */
const FOMO_STALE_MS = 10 * 60_000;
/** 随便一个存在的档案页，只是用来让前端发出那个请求；userId 会被重写掉。 */
const PLATFORM_PNL_SEED_HANDLE = process.env.FOMO_PLATFORM_PNL_SEED ?? 'ogle';

const upsertIdentity = db.prepare(
  `INSERT INTO fomo_identities (address, user_id, handle, followers, updated_ts) VALUES (?,?,?,?,?)
   ON CONFLICT(address) DO UPDATE SET
     user_id = COALESCE(excluded.user_id, fomo_identities.user_id),
     handle  = COALESCE(excluded.handle,  fomo_identities.handle),
     followers = COALESCE(excluded.followers, fomo_identities.followers),
     updated_ts = excluded.updated_ts`,
);
const upsertLeader = db.prepare(
  `INSERT INTO fomo_leaderboard (user_id, rank, handle, address, followers, pnl_24h, updated_ts) VALUES (?,?,?,?,?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET
     rank = excluded.rank, handle = excluded.handle, address = COALESCE(excluded.address, fomo_leaderboard.address),
     followers = excluded.followers, pnl_24h = excluded.pnl_24h, updated_ts = excluded.updated_ts`,
);
const upsertTokenStats = db.prepare(
  `INSERT INTO fomo_token_stats (ca, fomo_holders, updated_ts, resp_ts, ingest_ms) VALUES (?,?,?,?,?)
   ON CONFLICT(ca) DO UPDATE SET fomo_holders = excluded.fomo_holders,
     updated_ts = excluded.updated_ts, resp_ts = excluded.resp_ts, ingest_ms = excluded.ingest_ms`,
);
const upsertTokenHolder = db.prepare(
  `INSERT INTO fomo_token_holders (ca, rank, user_id, handle, evm_address, followers, amount, pnl, is_dev, updated_ts)
   VALUES (?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(ca, rank) DO UPDATE SET
     user_id = excluded.user_id, handle = excluded.handle, evm_address = excluded.evm_address,
     followers = excluded.followers, amount = excluded.amount, pnl = excluded.pnl,
     is_dev = excluded.is_dev, updated_ts = excluded.updated_ts`,
);

/**
 * 榜单和 Top 持有人都是「整份替换」语义，但 upsert 只会更新命中的键，
 * 落榜的人和多出来的名次会一直留着。实测：库里 158 行占 150 个名次，
 * 名次 150 同时被 4 个不同用户占着（跨 15 分钟）；某个币 47 行只有 46 个
 * 不同用户，同一个人会在卡片上出现两次。所以每批写完都要删掉这一批之外的旧行。
 */
const pruneLeaderboard = db.prepare('DELETE FROM fomo_leaderboard WHERE updated_ts < ?');
const pruneTokenHolders = db.prepare('DELETE FROM fomo_token_holders WHERE ca = ? AND updated_ts < ?');

/** 「在线」只能由这几个真正承载业务数据的接口来证明。 */
const BUSINESS_PATHS = new Set(['/v2/leaderboard/24h', '/hodlers/top']);

const seenEndpoints = new Map<string, { hits: number; records: number }>();

class BrowserFomo implements FomoProvider {
  ready = false;
  private ctx!: BrowserContext;
  private page!: Page;
  private ingestMs = 0;
  private navQueue: {
    priority: number; seq: number; deadline: number;
    fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void;
  }[] = [];
  private navRunning = false;
  private navSeq = 0;
  private stopped = false;
  private authFailures = 0;
  private lastBusinessOkTs = 0;
  private platformCache = new Map<string, { at: number; value: PlatformPnl }>();
  lastLeaderboardRefresh = 0;
  /**
   * 等某个接口的响应真正落库，而不是盲等固定秒数。
   * 之前就是因为盲等：probeAuth 等完 9 秒后立刻导航，把还在飞的榜单请求取消了，
   * 结果榜单一条都没抓到。
   */
  private waiters = new Map<string, (() => void)[]>();

  private waitForPath(path: string, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { drop(); resolve(false); }, timeoutMs);
      const done = () => { clearTimeout(timer); drop(); resolve(true); };
      const drop = () => {
        const list = this.waiters.get(path);
        if (!list) return;
        const i = list.indexOf(done);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.waiters.delete(path);
      };
      const list = this.waiters.get(path) ?? [];
      list.push(done);
      this.waiters.set(path, list);
    });
  }

  private notify(path: string): void {
    const list = this.waiters.get(path);
    if (!list?.length) return;
    this.waiters.delete(path);
    for (const fn of list) fn();
  }

  async init(): Promise<void> {
    if (!hasSession()) {
      setHealth('fomo_source', 'no_session');
      log.warn('还没有 FOMO 会话目录；后台会等待登录状态出现');
      return;
    }
    await this.openBrowser();

    // 榜单接口只在应用**冷启动**时打一次，而 probeAuth 本身就会触发一次冷启动。
    // 所以在它导航之前先把等待挂上，别等它跑完再单独重启一次——那次会慢到超时
    // （实测超时后 6ms 响应才到）。
    const leaderboardSeen = this.waitForPath('/v2/leaderboard/24h', 60_000);
    const probe = await probeAuth(this.ctx, this.page);
    this.ready = probe.loggedIn;
    if (this.ready) {
      const got = await leaderboardSeen;
      const n = (db.prepare('SELECT COUNT(*) n FROM fomo_leaderboard').get() as any).n;
      log.info({ 榜单条目: n, 等到响应: got }, '首次启动已抓取盈利榜');
    }
    if (!this.ready) {
      log.warn({ 地址: probe.finalUrl, API调用: probe.apiCalls },
        `${probe.reason}。跑 \`npm run login\` 并在**它打开的那个窗口里**登录——日常 Chrome 的登录不会带过来。`);
    }
  }

  private async openBrowser(): Promise<void> {
    this.ctx = await openContext();
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    // Playwright 不会接住 async 事件处理器的 rejection；数据库短暂争锁等异常若直接
    // 冒泡，会变成 unhandled rejection 并结束整个监控进程。
    this.ctx.on('response', r => void this.onResponse(r).catch(err =>
      log.error({ err: String(err).slice(0, 180), url: r.url().slice(0, 140) }, 'FOMO 响应处理失败')));
  }

  /**
   * 保证 `this.page` 可用。
   *
   * 实测踩过：共享页被关掉后（`page.goto: Target page, context or browser has been closed`），
   * refreshLeaderboard 每 5 分钟失败一次、tokenStats 也再没法导航，于是所有币永远停在
   * 「待预热」，触发彻底停摆——而 `ready` 还是 true，连降级成纯链上模式都没发生。
   */
  private async ensurePage(): Promise<void> {
    if (!this.ctx) { await this.openBrowser(); return; }
    if (this.page && !this.page.isClosed()) return;
    try { this.page = await this.ctx.newPage(); }
    catch { await this.openBrowser(); }
  }

  /** 关键业务接口最后一次成功解析距今多久。数据源是否还活着以此为准。 */
  businessStaleMs(): number {
    return this.lastBusinessOkTs ? Date.now() - this.lastBusinessOkTs : Infinity;
  }

  /**
   * 业务接口久未成功就必须**主动降级**：把 ready 置 false。
   * 这样 Engine 会走 `!fomo.ready` 分支进入纯链上模式继续告警（FOMO 字段显示 n/a），
   * 而不是所有币都卡在「等 FOMO 预热」上永远不触发。
   */
  markStaleIfNeeded(maxAgeMs: number): boolean {
    if (!this.ready || this.businessStaleMs() <= maxAgeMs) return false;
    this.ready = false;
    setHealth('fomo_source', 'stale');
    log.warn({ 距上次成功业务响应秒: Math.round(this.businessStaleMs() / 1000) },
      'FOMO 业务接口久未成功，降级为纯链上模式并尝试恢复');
    return true;
  }

  /** 会话过期或浏览器退出后重新探测；成功 API 响应是唯一的在线判据。 */
  async recoverAuth(): Promise<void> {
    if (this.stopped || !hasSession()) return;
    try {
      await this.ensurePage();
      await this.nav('alert', 30_000, async () => {
        const probe = await probeAuth(this.ctx, this.page, 6_000);
        this.ready = probe.loggedIn;
        setHealth('fomo_source', this.ready ? 'ok' : 'auth_error');
      });
    } catch (err) {
      this.ready = false;
      setHealth('fomo_source', 'browser_error');
      log.warn({ err: String(err).slice(0, 140) }, 'FOMO 浏览器恢复失败');
    }
  }

  /**
   * 拦响应 → 解析 → **一个事务里**落库。这段耗时（到 COMMIT 结束为止）就是「浏览器→入库」。
   *
   * 三件以前不成立的事：
   *  1. 在线状态只能由**关键业务接口成功解析**来证明。以前任何 fomo 域名的 200
   *     （`/config`、`/static/*.js` 这种公共资源）都会把 authFailures 清零并把
   *     fomo_source 置成 ok，鉴权故障就被无关的 200 抵消了。
   *  2. 总人数、Top 列表、旧行清理必须同一个事务提交。以前先写 fomo_token_stats
   *     （包含「新鲜时间」），再逐行写 Top 列表——中途失败就留下「时间是新的、
   *     榜是旧的」的半新半旧数据，而消费方只看时间。
   *  3. ingest 耗时以前在写 Top 列表**之前**就结算了，量的不是真正的入库。
   */
  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    if (!isFomoApi(url)) return;
    let path: string;
    try { path = new URL(url).pathname; } catch { return; }
    const business = BUSINESS_PATHS.has(path);

    if (!res.ok()) {
      if ([401, 403, 430, 431].includes(res.status()) && ++this.authFailures >= 3) {
        this.ready = false;
        setHealth('fomo_source', 'auth_error');
      }
      return;
    }
    if (!(res.headers()['content-type'] ?? '').includes('json')) return;

    const respTs = Date.now();
    let json: unknown;
    try { json = await res.json(); } catch (err) {
      // 响应体读不出来 ≠ 鉴权失败 ≠ 数据为空。三者必须分开记。
      if (business) setHealth('fomo_source', 'parse_error');
      log.debug({ path, err: String(err).slice(0, 100) }, 'API 响应体读取失败');
      return;
    }
    log.debug({ path }, 'API 响应');

    let records = 0;
    const now = Date.now();
    try {
      if (path === '/v2/leaderboard/24h') {
        // 只认 24h 那份；7d / 30d 会覆盖掉 24h 的名次和盈亏
        const { shapeOk, rows } = parseLeaderboardResult(json);
        if (!shapeOk) {
          // 结构不对 ≠ 数据为空。接口改了就该报出来，不能静默当成「今天没人上榜」。
          setHealth('fomo_source', 'parse_error');
          log.warn({ path }, '榜单响应结构不符合预期，未入库，也不视为在线');
          return;
        }
        if (rows.length) {
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const r of rows) {
              upsertLeader.run(r.userId ?? r.handle ?? String(r.rank), r.rank, r.handle ?? '?', r.evmAddress, r.followers, r.pnl24h, now);
              if (r.evmAddress) upsertIdentity.run(r.evmAddress, r.userId, r.handle, r.followers, now);
            }
            // 榜单是「整份替换」语义，但 upsert 只更新命中的键：落榜的人会一直留着。
            pruneLeaderboard.run(now);
            db.exec('COMMIT');
          } catch (err) { db.exec('ROLLBACK'); throw err; }
        } else {
          // 解析成功但是空的——这是「数据为空」，不是失败，也不该刷新任何时间戳。
          setHealth('fomo_leaderboard_empty', now);
        }
        records = rows.length;
        this.markOnline(respTs);
      } else if (path.startsWith('/v2/leaderboard')) {
        return;                                       // 7d / 30d：不入库、也不当在线判据
      } else if (path === '/hodlers/top') {
        const res = parseHodlersTopResult(json);
        if (!res.shapeOk) {
          setHealth('fomo_source', 'parse_error');
          log.warn({ path }, '/hodlers/top 响应结构不符合预期，未入库，也不视为在线');
          return;
        }
        const parsed = res.rows.filter(t => t.networkId === null || t.networkId === ROBINHOOD_NETWORK_ID);
        const ready: string[] = [];
        for (const t of parsed) {
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const h of t.top) {
              upsertTokenHolder.run(t.ca, h.rank, h.user.userId, h.user.handle, h.user.evmAddress,
                h.user.followers, h.amount, h.pnl, h.isDev ? 1 : 0, now);
              if (h.user.evmAddress) upsertIdentity.run(h.user.evmAddress, h.user.userId, h.user.handle, h.user.followers, now);
            }
            pruneTokenHolders.run(t.ca, now);          // 本批之外的旧行会让同一个人重复出现
            // 「新鲜时间」最后写：Top 列表写失败就整笔回滚，不会留下半新半旧。
            upsertTokenStats.run(t.ca, t.fomoHolders, now, respTs, Date.now() - respTs);
            db.exec('COMMIT');
          } catch (err) { db.exec('ROLLBACK'); throw err; }
          ready.push(t.ca);
          records += t.top.length;
        }
        // 事务提交之后才唤醒等待者，别让人读到未提交的状态
        for (const ca of ready) this.notify(`/hodlers/top:${ca}`);
        if (parsed.length) this.markOnline(respTs);
      } else {
        // 其他端点用形状启发式顺手捞点身份信息，捞不到也无所谓；**不作为在线判据**
        for (const r of harvest(json)) {
          if (r.address) { upsertIdentity.run(r.address, r.userId, r.handle, r.followers, now); records++; }
        }
      }
    } catch (err) {
      if (business) setHealth('fomo_source', 'ingest_error');
      log.error({ path, err: String(err).slice(0, 220) }, '解析/入库失败');
      return;
    }
    if (business) {
      this.ingestMs = Date.now() - respTs;             // 量到 COMMIT 结束为止
      setHealth('fomo_ingest_ms', this.ingestMs);
    }
    this.notify(path);
    const e = seenEndpoints.get(path) ?? { hits: 0, records: 0 };
    e.hits++; e.records += records;
    seenEndpoints.set(path, e);
  }

  /** 只有关键业务接口成功解析才算在线。 */
  private markOnline(respTs: number): void {
    this.authFailures = 0;
    this.ready = true;
    this.lastBusinessOkTs = respTs;
    setHealth('fomo_source', 'ok');
    setHealth('fomo_business_ok_ts', respTs);
  }

  /** 单页导航调度：复核 > 告警 > 预热 > 榜单，并给告警任务明确排队截止时间。 */
  private nav<T>(kind: 'recheck' | 'alert' | 'prewarm' | 'background', deadlineMs: number, fn: () => Promise<T>): Promise<T> {
    const weight = { recheck: 0, alert: 1, prewarm: 2, background: 3 }[kind];
    return new Promise<T>((resolve, reject) => {
      this.navQueue.push({ priority: weight, seq: this.navSeq++, deadline: Date.now() + deadlineMs,
        fn, resolve: resolve as (v: unknown) => void, reject });
      this.navQueue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      void this.drainNav();
    });
  }

  private async drainNav(): Promise<void> {
    if (this.navRunning) return;
    this.navRunning = true;
    try {
      while (this.navQueue.length) {
        const task = this.navQueue.shift()!;
        if (Date.now() > task.deadline) {
          task.reject(new Error('FOMO 导航排队超时'));
          continue;
        }
        try { task.resolve(await task.fn()); } catch (err) { task.reject(err); }
      }
    } finally { this.navRunning = false; }
  }

  /**
   * 刷新 24H 盈利榜。前端路由表里根本没有 /leaderboard——
   * 排行榜是登录后 `/` 那套 authenticated layout 渲染的，逛首页就会触发接口。
   */
  async refreshLeaderboard(): Promise<void> {
    if (!this.ready || this.stopped) return;
    // 这一趟要占住导航锁最多约 85 秒（about:blank + goto 25s + 等响应 60s）。
    // 有告警正在等代币页时就先让路——卡片的时效性比榜单刷新重要。
    if (this.navQueue.length > 0 || this.navRunning) { log.debug('导航队列非空，本轮跳过榜单刷新'); return; }
    await this.nav('background', 90_000, async () => {
      try {
        await this.ensurePage();          // 页可能已经被关掉了
        // 榜单只在应用**冷启动**时拉一次；SPA 内部再导航到 `/` 不会重新拉，
        // 而且 `/` 会被重定向到 `/token`，首页 feed 根本不渲染。
        // 先跳 about:blank 把应用卸掉，再进来才算一次完整启动。
        await this.page.goto('about:blank').catch(() => {});
        const seen = this.waitForPath('/v2/leaderboard/24h', 60_000);
        await this.page.goto(FOMO_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        const got = await seen;
        const n = (db.prepare('SELECT COUNT(*) n FROM fomo_leaderboard').get() as any).n;
        if (got && n > 0) log.info({ 榜单条目: n }, '盈利榜已更新');
        else log.warn({ 已入库: n }, '没等到 /v2/leaderboard/24h 响应');
      } catch (err) {
        log.warn({ err: String(err).slice(0, 140) }, '刷新盈利榜失败');
      }
    });
    this.lastLeaderboardRefresh = Date.now();
  }

  async leaderboard24h(): Promise<FomoLeader[]> {
    return (db.prepare('SELECT * FROM fomo_leaderboard ORDER BY rank ASC LIMIT 500').all() as any[])
      .map(r => ({ rank: r.rank, userId: r.user_id, handle: r.handle, evmAddress: r.address,
        followers: r.followers, pnl24h: r.pnl_24h, updatedTs: r.updated_ts }));
  }

  tokenStatsWarm(ca: string, maxAgeMs = 60_000): boolean {
    const row = db.prepare('SELECT updated_ts FROM fomo_token_stats WHERE ca = ?')
      .get(ca.toLowerCase()) as { updated_ts: number } | undefined;
    return !!row && Date.now() - row.updated_ts <= maxAgeMs;
  }

  /** 逛一次这个币的代币页，前端会去打 /hodlers/top，我们从响应里落库再读回来。 */
  async tokenStats(ca: string, maxAgeMs = 60_000, priority: 'recheck' | 'alert' | 'prewarm' = 'alert'): Promise<FomoTokenStats | null> {
    if (!this.ready) return null;
    const key = ca.toLowerCase();
    const fresh = () => db.prepare('SELECT fomo_holders, updated_ts, resp_ts, ingest_ms FROM fomo_token_stats WHERE ca = ?').get(key) as any;

    let row = fresh();

    if (!row || Date.now() - row.updated_ts > maxAgeMs) {
      const navigate = async (page: Page) => {
        // 排队期间别的任务可能已经刷新了同一个币。
        const current = fresh();
        if (current && Date.now() - current.updated_ts <= maxAgeMs) return;
        try {
          // 等待必须按代币区分：以前所有 /hodlers/top 的等待共用一个键，
          // A 币还在飞的响应会直接放行 B 币的等待，B 拿到空数据被误判成 Fomo=0。
          const seen = this.waitForPath(`/hodlers/top:${key}`, 20_000);
          await page.goto(links.fomo(ca), { waitUntil: 'domcontentloaded', timeout: 25_000 });
          await seen;
        } catch { /* 页面打不开就用旧数据 */ }
      };
      if (priority === 'recheck') {
        // 复核有绝对时间目标，不能被一个已经开始的低优先级预热阻塞几十秒。
        const page = await this.ctx.newPage();
        try { await navigate(page); } finally { await page.close().catch(() => {}); }
      } else {
        await this.nav(priority, priority === 'prewarm' ? 60_000 : 25_000, async () => {
          await this.ensurePage();
          return navigate(this.page);
        });
      }
      row = fresh();
    }
    // maxAgeMs 是正确性约束，不只是“要不要尝试刷新”的提示。刷新失败不能回退到旧值。
    if (!row || Date.now() - row.updated_ts > maxAgeMs) return null;

    const top = (db.prepare(
      'SELECT rank, user_id, handle, evm_address, followers, amount, pnl, is_dev FROM fomo_token_holders WHERE ca = ? ORDER BY rank ASC LIMIT 50',
    ).all(key) as any[]).map((h): FomoTopHolder => ({
      rank: h.rank, userId: h.user_id, handle: h.handle, evmAddress: h.evm_address,
      followers: h.followers, amount: h.amount, pnl: h.pnl, isDev: !!h.is_dev,
    }));

    return {
      fomoHolders: row.fomo_holders, top, freshMs: Date.now() - row.updated_ts,
      // takenTs 是 FOMO 响应到达的时间，不是入库提交时间——两者分开记
      takenTs: row.resp_ts ?? row.updated_ts, ingestMs: row.ingest_ms ?? 0,
    };
  }

  /**
   * 任意用户的全平台 24H 收益 = `aggregatedSnapshot` 序列的 `pnl[最新] − pnl[最新−24h]`。
   *
   * 取数办法是**重写页面自己发出的那个请求**的 userId：这样请求头和浏览器指纹
   * 都是应用原样，不需要读取任何凭据。窗口对齐到整点，比榜单的实时口径滞后 ≤1 小时，
   * 所以窗口标成 'snapshot'，不能和榜单的 'live' 混着求和。
   */
  async platformPnl24h(userIds: string[]): Promise<Map<string, PlatformPnl>> {
    const out = new Map<string, PlatformPnl>();
    if (!PLATFORM_PNL_ENABLED || !this.ready || this.stopped) return out;
    const now = Date.now();
    const wanted: string[] = [];
    for (const id of userIds) {
      const hit = this.platformCache.get(id);
      if (hit && now - hit.at <= 10 * 60_000) out.set(id, hit.value);
      else wanted.push(id);
    }
    if (!wanted.length) return out;

    await this.nav('prewarm', 120_000, async () => {
      const page = await this.ctx.newPage();
      let sub: string | null = null;
      const series = new Map<string, { snapshotId: number; pnl: number }[]>();
      try {
        await page.route('**/v2/userTokens/aggregatedSnapshot*', async route => {
          const u = new URL(route.request().url());
          if (sub) u.searchParams.set('userId', sub);
          await route.continue({ url: u.toString() });
        });
        page.on('response', async r => {
          try {
            if (!isFomoApi(r.url())) return;
            const u = new URL(r.url());
            if (u.pathname !== '/v2/userTokens/aggregatedSnapshot' || !r.ok()) return;
            const ro = (await r.json())?.responseObject;
            const id = u.searchParams.get('userId');
            if (id && Array.isArray(ro) && ro.length > (series.get(id)?.length ?? 0)) series.set(id, ro);
          } catch { /* 诊断路径，失败无所谓 */ }
        });
        for (const id of wanted) {
          if (this.stopped) break;
          sub = id;
          await page.goto('about:blank').catch(() => {});
          await page.goto(`${FOMO_ORIGIN}/profile/${PLATFORM_PNL_SEED_HANDLE}`,
            { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
          await page.waitForTimeout(5_000);
        }
      } finally { await page.close().catch(() => {}); }

      for (const [id, rows] of series) {
        const latest = rows[rows.length - 1];
        if (!latest) continue;
        const target = latest.snapshotId - DAY_SEC;
        const prev = [...rows].reverse().find(r => r.snapshotId <= target);
        // 序列不够长就没有 24 小时窗口。宁可缺这一项，也不能拿更短的窗口冒充。
        if (!prev) continue;
        const value = { value: latest.pnl - prev.pnl, window: 'snapshot' as const, asOfTs: latest.snapshotId * 1000 };
        this.platformCache.set(id, { at: Date.now(), value });
        out.set(id, value);
      }
    }).catch(err => log.debug({ err: String(err).slice(0, 120) }, '取全平台 24H 收益失败'));
    return out;
  }

  isStopped(): boolean { return this.stopped; }

  ingestLatencyMs(): number { return this.ingestMs; }

  async close(): Promise<void> {
    this.stopped = true;
    await this.ctx?.close().catch(() => {});
  }
}

export function endpointReport(): { path: string; hits: number; records: number }[] {
  return [...seenEndpoints].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.records - a.records);
}

export async function createFomoProvider(): Promise<FomoProvider> {
  const p = new BrowserFomo();
  await p.init();                                   // init 里已经顺带抓过一次榜单
  void (async () => {
    while (!p.isStopped()) {
      await new Promise(r => setTimeout(r, 60_000));
      // 只看 ready 是不够的：页被关掉时 ready 仍是 true，恢复逻辑永远不会跑。
      // 关键业务接口超过 10 分钟没成功，就主动降级并尝试恢复。
      p.markStaleIfNeeded(FOMO_STALE_MS);
      if (!p.ready) await p.recoverAuth().catch(() => {});
      else if (Date.now() - p.lastLeaderboardRefresh > 5 * 60_000) await p.refreshLeaderboard().catch(() => {});
    }
  })();
  return p;
}
