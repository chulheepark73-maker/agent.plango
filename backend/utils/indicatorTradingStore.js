/**
 * 지표기반매매 설정·상태 (사용자별, 컬럼 저장)
 */

const pool = require('./tradingDb');

/** 스키마는 db/trading_schema.sql 에서 생성된다 */
const ensureTable = async () => {};

const DEFAULT_SETTINGS = {
  buyAmountKrw: 1000000,
  buyCondition: '',
  buyTimeStart: '15:00',
  buyTimeEnd: '15:20',
  useSplitBuy: false,
  buyEndMarketFill: false,
  buyLimitTickOffset: 2,
  sellLimitTickOffset: 2,
  useTakeProfit: true,
  takeProfitPercent: 1.5,
  useStopLoss: true,
  stopLossPercent: -1,
  useTrailingStop: false,
  trailingStopOnPercent: 2,
  trailingStopFromHighPercent: -1,
  useDailyMaSell: false,
  dailySellMa: 20,
  useMinuteMaSell: false,
  minuteChartSetting: 3,
  minuteSellMa: 20,
  maxTrackingStocks: 90,
  maxHoldingStocks: 5,
  maxUsageAmountKrw: 10000000,
};

const SETTING_COLUMNS = [
  { key: 'buyAmountKrw', column: 'buy_amount_krw', type: 'number' },
  { key: 'buyCondition', column: 'buy_condition', type: 'string' },
  { key: 'buyTimeStart', column: 'buy_time_start', type: 'string' },
  { key: 'buyTimeEnd', column: 'buy_time_end', type: 'string' },
  { key: 'useSplitBuy', column: 'use_split_buy', type: 'boolean' },
  { key: 'buyEndMarketFill', column: 'buy_end_market_fill', type: 'boolean' },
  { key: 'buyLimitTickOffset', column: 'buy_limit_tick_offset', type: 'int' },
  { key: 'sellLimitTickOffset', column: 'sell_limit_tick_offset', type: 'int' },
  { key: 'useTakeProfit', column: 'use_take_profit', type: 'boolean' },
  { key: 'takeProfitPercent', column: 'take_profit_percent', type: 'number' },
  { key: 'useStopLoss', column: 'use_stop_loss', type: 'boolean' },
  { key: 'stopLossPercent', column: 'stop_loss_percent', type: 'number' },
  { key: 'useTrailingStop', column: 'use_trailing_stop', type: 'boolean' },
  { key: 'trailingStopOnPercent', column: 'trailing_stop_on_percent', type: 'number' },
  { key: 'trailingStopFromHighPercent', column: 'trailing_stop_from_high_percent', type: 'number' },
  { key: 'useDailyMaSell', column: 'use_daily_ma_sell', type: 'boolean' },
  { key: 'dailySellMa', column: 'daily_sell_ma', type: 'int' },
  { key: 'useMinuteMaSell', column: 'use_minute_ma_sell', type: 'boolean' },
  { key: 'minuteChartSetting', column: 'minute_chart_setting', type: 'int' },
  { key: 'minuteSellMa', column: 'minute_sell_ma', type: 'int' },
  { key: 'maxTrackingStocks', column: 'max_tracking_stocks', type: 'int' },
  { key: 'maxHoldingStocks', column: 'max_holding_stocks', type: 'int' },
  { key: 'maxUsageAmountKrw', column: 'max_usage_amount_krw', type: 'number' },
];

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

const toNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === true || value === 1 || value === '1') return true;
  if (value === 'false' || value === false || value === 0 || value === '0') return false;
  return fallback;
};

const toStr = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s === '' ? fallback : s;
};

const coerceValue = (type, value, fallback) => {
  if (type === 'boolean') return toBool(value, fallback);
  if (type === 'int') return toInt(value, fallback);
  if (type === 'number') return toNum(value, fallback);
  return toStr(value, fallback);
};

const mapRowToSettings = (row) => {
  const settings = { ...DEFAULT_SETTINGS };
  if (!row) return settings;
  for (const { key, column, type } of SETTING_COLUMNS) {
    if (row[column] !== undefined && row[column] !== null) {
      settings[key] = coerceValue(type, row[column], DEFAULT_SETTINGS[key]);
    }
  }
  return settings;
};

const mergeSettings = (saved) => {
  const next = { ...DEFAULT_SETTINGS };
  if (!saved || typeof saved !== 'object') return next;
  for (const { key, type } of SETTING_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== undefined) {
      next[key] = coerceValue(type, saved[key], DEFAULT_SETTINGS[key]);
    }
  }
  return next;
};

const settingsToParams = (settings) => SETTING_COLUMNS.map(({ key }) => settings[key]);

const columnList = SETTING_COLUMNS.map(({ column }) => column).join(', ');
const insertPlaceholders = SETTING_COLUMNS.map((_, i) => `$${i + 2}`).join(', ');
const updateAssignments = SETTING_COLUMNS.map(
  ({ column }, i) => `${column} = EXCLUDED.${column}`
).join(',\n       ');

const SELECT_COLUMNS = `
  user_id, ${columnList}, tracking_stocks,
  auto_trading_enabled, api_connected, stock_info_loaded_count, updated_at
`;

const toPublicRow = (row) => {
  if (!row) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      trackingStocks: [],
      autoTradingEnabled: false,
      apiConnected: false,
      stockInfoLoadedCount: 0,
      updatedAt: null,
    };
  }
  return {
    settings: mapRowToSettings(row),
    trackingStocks: Array.isArray(row.tracking_stocks) ? row.tracking_stocks : [],
    autoTradingEnabled: !!row.auto_trading_enabled,
    apiConnected: !!row.api_connected,
    stockInfoLoadedCount: Number(row.stock_info_loaded_count || 0),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
};

const getIndicatorTrading = async (userId) => {
  await ensureTable();
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM indicator_trading WHERE user_id = $1`,
    [String(userId)]
  );
  return toPublicRow(result.rows[0] || null);
};

const upsertSettings = async (userId, settings, extras = {}) => {
  const uid = String(userId);
  const now = new Date();
  const autoTrading =
    extras.autoTradingEnabled !== undefined ? !!extras.autoTradingEnabled : undefined;
  const apiConnected = extras.apiConnected !== undefined ? !!extras.apiConnected : undefined;
  const stockCount =
    extras.stockInfoLoadedCount !== undefined ? extras.stockInfoLoadedCount : undefined;

  const params = [uid, ...settingsToParams(settings)];
  let extraInsertCols = '';
  let extraInsertVals = '';
  let extraUpdate = '';
  let p = params.length + 1;

  if (autoTrading !== undefined) {
    extraInsertCols += ', auto_trading_enabled';
    extraInsertVals += `, $${p}`;
    extraUpdate += ',\n       auto_trading_enabled = EXCLUDED.auto_trading_enabled';
    params.push(autoTrading);
    p += 1;
  }
  if (apiConnected !== undefined) {
    extraInsertCols += ', api_connected';
    extraInsertVals += `, $${p}`;
    extraUpdate += ',\n       api_connected = EXCLUDED.api_connected';
    params.push(apiConnected);
    p += 1;
  }
  if (stockCount !== undefined) {
    extraInsertCols += ', stock_info_loaded_count';
    extraInsertVals += `, $${p}`;
    extraUpdate += ',\n       stock_info_loaded_count = EXCLUDED.stock_info_loaded_count';
    params.push(stockCount);
    p += 1;
  }

  extraInsertCols += ', updated_at';
  extraInsertVals += `, $${p}`;
  extraUpdate += ',\n       updated_at = EXCLUDED.updated_at';
  params.push(now);

  await pool.query(
    `INSERT INTO indicator_trading (user_id, ${columnList}${extraInsertCols})
     VALUES ($1, ${insertPlaceholders}${extraInsertVals})
     ON CONFLICT (user_id) DO UPDATE SET
       ${updateAssignments}${extraUpdate}`,
    params
  );
};

const saveIndicatorTradingSettings = async (userId, settingsPatch) => {
  await ensureTable();
  const current = await getIndicatorTrading(userId);
  const nextSettings = mergeSettings({ ...current.settings, ...settingsPatch });
  await upsertSettings(userId, nextSettings, {
    autoTradingEnabled: current.autoTradingEnabled,
    apiConnected: current.apiConnected,
    stockInfoLoadedCount: current.stockInfoLoadedCount,
  });
  return getIndicatorTrading(userId);
};

const setAutoTradingEnabled = async (userId, enabled) => {
  await ensureTable();
  const current = await getIndicatorTrading(userId);
  await upsertSettings(userId, current.settings, {
    autoTradingEnabled: !!enabled,
    apiConnected: current.apiConnected,
    stockInfoLoadedCount: current.stockInfoLoadedCount,
  });
  return getIndicatorTrading(userId);
};

const setApiConnected = async (userId, connected, stockInfoLoadedCount = null) => {
  await ensureTable();
  const current = await getIndicatorTrading(userId);
  const count = stockInfoLoadedCount != null ? stockInfoLoadedCount : current.stockInfoLoadedCount;
  await upsertSettings(userId, current.settings, {
    autoTradingEnabled: current.autoTradingEnabled,
    apiConnected: !!connected,
    stockInfoLoadedCount: count,
  });
  return getIndicatorTrading(userId);
};

const getTrackingStocks = async (userId) => {
  await ensureTable();
  const result = await pool.query(
    'SELECT tracking_stocks FROM indicator_trading WHERE user_id = $1',
    [String(userId)]
  );
  if (!result.rows.length) return [];
  const list = result.rows[0].tracking_stocks;
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const next = { ...row };
    delete next.executionStrength;
    delete next.programNetBuy;
    return next;
  });
};

const saveTrackingStocks = async (userId, stocks) => {
  await ensureTable();
  // 감시 목록만 저장 — 주문/포지션 필드는 indicator_positions 담당
  const list = (Array.isArray(stocks) ? stocks : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const next = { ...row };
    delete next.executionStrength;
    delete next.programNetBuy;
    delete next.buyPrice;
    delete next.buyQty;
    delete next.buyOrderNo;
    delete next.buyOrderStatus;
    delete next.sellOrderStatus;
    delete next.lastReason;
    delete next.positionId;
    delete next.profitRate;
    return next;
  });
  const current = await getIndicatorTrading(userId);
  await upsertSettings(userId, current.settings, {
    autoTradingEnabled: current.autoTradingEnabled,
    apiConnected: current.apiConnected,
    stockInfoLoadedCount: current.stockInfoLoadedCount,
  });
  await pool.query(
    `UPDATE indicator_trading SET tracking_stocks = $2, updated_at = $3 WHERE user_id = $1`,
    [String(userId), JSON.stringify(list), new Date()]
  );
  // 행이 없을 수 있음 — upsertSettings 후 다시 확인
  const check = await pool.query('SELECT 1 FROM indicator_trading WHERE user_id = $1', [
    String(userId),
  ]);
  if (check.rows.length === 0) {
    await pool.query(
      `INSERT INTO indicator_trading (user_id, tracking_stocks, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         tracking_stocks = EXCLUDED.tracking_stocks,
         updated_at = EXCLUDED.updated_at`,
      [String(userId), JSON.stringify(list), new Date()]
    );
  }
  return getTrackingStocks(userId);
};

/** 지표기반매매 자동매매 ON 사용자 */
const listAutoTradingUserIds = async () => {
  await ensureTable();
  const result = await pool.query(
    `SELECT user_id FROM indicator_trading WHERE auto_trading_enabled = true`
  );
  return result.rows.map((r) => String(r.user_id));
};

module.exports = {
  DEFAULT_SETTINGS,
  getIndicatorTrading,
  saveIndicatorTradingSettings,
  setAutoTradingEnabled,
  setApiConnected,
  getTrackingStocks,
  saveTrackingStocks,
  listAutoTradingUserIds,
};
