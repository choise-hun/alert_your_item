/**
 * ============================================================================
 * [Node.js 홈서버용] 다중 쇼핑몰 신상품 & 재입고 크롤링 모니터 (node_product_monitor.js)
 * ============================================================================
 *
 * Google Apps Script에서 클라우드 IP 차단이나 실행 시간 제한(6분)에 걸리는 사이트까지
 * 홈서버(가정용 IP)에서 안정적으로 모니터링할 수 있는 단일 파일 Node.js 서버입니다.
 *
 * [설치 및 실행 방법]
 * 1. 패키지 설치:
 *    npm init -y
 *    npm install express axios cheerio iconv-lite node-cron
 *
 * 2. 서버 실행:
 *    node node_product_monitor.js
 *
 * 3. 브라우저에서 접속:
 *    http://localhost:3000
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'monitor_db.json');

app.use(express.json());

// github.io 등 외부 정적 페이지에서 홈서버 API를 호출할 수 있도록 CORS 허용
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ----------------------------------------------------------------------------
// 1. 로컬 JSON 데이터베이스 로드/저장
// ----------------------------------------------------------------------------
function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { watches: [], snapshots: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ----------------------------------------------------------------------------
// 2. 한/영 상품 키워드 파싱 및 경우의 수 확장 엔진
// ----------------------------------------------------------------------------
const ROMAN_TO_NUM = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5',
  vi: '6', vii: '7', viii: '8', ix: '9', x: '10'
};
const NUM_TO_ROMAN = {
  '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v',
  '6': 'vi', '7': 'vii', '8': 'viii', '9': 'ix', '10': 'x'
};

const BUILTIN_SYNONYMS = {
  fender: ['fender', '펜더'],
  '펜더': ['fender', '펜더'],
  jaguar: ['jaguar', '재규어', '쟈규어'],
  '재규어': ['jaguar', '재규어', '쟈규어'],
  stratocaster: ['stratocaster', 'strat', '스트랫', '스트라토캐스터'],
  '스트랫': ['stratocaster', 'strat', '스트랫', '스트라토캐스터'],
  telecaster: ['telecaster', 'tele', '텔레', '텔레캐스터'],
  '텔레': ['telecaster', 'tele', '텔레', '텔레캐스터'],
  jazzmaster: ['jazzmaster', '재즈마스터'],
  '재즈마스터': ['jazzmaster', '재즈마스터'],
  vintera: ['vintera', '빈테라'],
  '빈테라': ['vintera', '빈테라'],
  gibson: ['gibson', '깁슨'],
  '깁슨': ['gibson', '깁슨']
};

function expandSingleToken(rawToken) {
  const token = String(rawToken || '').trim().toLowerCase();
  if (!token) return null;

  let basePart = token;
  let numPart = null;

  const attachedDigitMatch = token.match(/^([a-z가-힣]{2,})[-_\s]?(10|[1-9])$/i);
  const attachedRomanMatch = token.match(/^([a-z가-힣]{2,})[-_\s]?(viii|vii|iii|iv|vi|ix|ii)$/i);

  if (attachedDigitMatch) {
    basePart = attachedDigitMatch[1];
    numPart = attachedDigitMatch[2];
  } else if (attachedRomanMatch) {
    basePart = attachedRomanMatch[1];
    numPart = ROMAN_TO_NUM[attachedRomanMatch[2].toLowerCase()];
  } else if (ROMAN_TO_NUM[token]) {
    basePart = '';
    numPart = ROMAN_TO_NUM[token];
  } else if (NUM_TO_ROMAN[token]) {
    basePart = '';
    numPart = token;
  }

  const baseSynonyms = basePart ? (BUILTIN_SYNONYMS[basePart] || [basePart]) : [];
  const versionVariants = [];
  if (numPart) {
    const roman = NUM_TO_ROMAN[numPart];
    versionVariants.push(numPart);
    if (roman && !versionVariants.includes(roman)) versionVariants.push(roman);
  }

  const combinedVariants = new Set();
  const displayKeywords = new Set();

  baseSynonyms.forEach(b => displayKeywords.add(b));
  versionVariants.forEach(v => displayKeywords.add(v));

  if (baseSynonyms.length > 0 && versionVariants.length > 0) {
    baseSynonyms.forEach(b => {
      versionVariants.forEach(v => {
        combinedVariants.add(b + v);
        combinedVariants.add(b + ' ' + v);
        combinedVariants.add(b + '-' + v);
        displayKeywords.add(b + v);
      });
    });
  } else if (baseSynonyms.length > 0) {
    baseSynonyms.forEach(b => combinedVariants.add(b));
  } else if (versionVariants.length > 0) {
    versionVariants.forEach(v => combinedVariants.add(v));
  }

  return {
    original: token,
    hasVersion: Boolean(numPart),
    baseVariants: Array.from(new Set(baseSynonyms)),
    versionVariants: Array.from(new Set(versionVariants)),
    combinedVariants: Array.from(combinedVariants),
    displayKeywords: Array.from(displayKeywords)
  };
}

function buildSingleKeywordRule(rawKeywordsEn, rawKeywordsKo) {
  const splitTokens = str => String(str || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const mergeVersionTokens = tokens => {
    const merged = [];
    for (let i = 0; i < tokens.length; i++) {
      const curr = tokens[i].toLowerCase();
      const next = i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : null;
      if (next && (ROMAN_TO_NUM[next] || NUM_TO_ROMAN[next]) && !/\d$/.test(curr)) {
        merged.push(curr + next);
        i++;
      } else {
        merged.push(curr);
      }
    }
    return merged;
  };

  const normEn = mergeVersionTokens(splitTokens(rawKeywordsEn));
  const normKo = mergeVersionTokens(splitTokens(rawKeywordsKo));
  const maxLen = Math.max(normEn.length, normKo.length);

  const conceptGroups = [];
  const allExpandedFlat = new Set();

  for (let i = 0; i < maxLen; i++) {
    const enExp = normEn[i] ? expandSingleToken(normEn[i]) : null;
    const koExp = normKo[i] ? expandSingleToken(normKo[i]) : null;

    const baseSet = new Set();
    const versionSet = new Set();
    const combinedSet = new Set();
    const displaySet = new Set();

    [enExp, koExp].forEach(exp => {
      if (!exp) return;
      exp.baseVariants.forEach(x => baseSet.add(x));
      exp.versionVariants.forEach(x => versionSet.add(x));
      exp.combinedVariants.forEach(x => combinedSet.add(x));
      exp.displayKeywords.forEach(x => {
        displaySet.add(x);
        allExpandedFlat.add(x);
      });
    });

    if (baseSet.size > 0 && versionSet.size > 0) {
      baseSet.forEach(b => {
        versionSet.forEach(v => {
          combinedSet.add(b + v);
          combinedSet.add(b + ' ' + v);
          combinedSet.add(b + '-' + v);
          displaySet.add(b + v);
          allExpandedFlat.add(b + v);
        });
      });
    }

    conceptGroups.push({
      index: i + 1,
      hasVersion: versionSet.size > 0,
      baseVariants: Array.from(baseSet),
      versionVariants: Array.from(versionSet),
      combinedVariants: Array.from(combinedSet),
      displayKeywords: Array.from(displaySet)
    });
  }

  return {
    rawKeywordsEn: rawKeywordsEn || '',
    rawKeywordsKo: rawKeywordsKo || '',
    allExpandedKeywords: Array.from(allExpandedFlat),
    conceptGroups
  };
}

function buildKeywordRules(rawKeywordsEn, rawKeywordsKo) {
  const splitClauses = str => String(str || '').split(/[;\n|]+/).map(s => s.trim()).filter(Boolean);
  const enClauses = splitClauses(rawKeywordsEn);
  const koClauses = splitClauses(rawKeywordsKo);
  const maxClauses = Math.max(enClauses.length, koClauses.length, 1);

  const subRules = [];
  const globalExpanded = new Set();

  for (let c = 0; c < maxClauses; c++) {
    const en = enClauses[c] || (enClauses.length === 1 ? enClauses[0] : '');
    const ko = koClauses[c] || (koClauses.length === 1 ? koClauses[0] : '');
    if (!en && !ko) continue;

    const single = buildSingleKeywordRule(en, ko);
    single.allExpandedKeywords.forEach(k => globalExpanded.add(k));
    subRules.push(single);
  }

  return {
    rawKeywordsEn: rawKeywordsEn || '',
    rawKeywordsKo: rawKeywordsKo || '',
    allExpandedKeywords: Array.from(globalExpanded),
    conceptGroups: subRules[0] ? subRules[0].conceptGroups : [],
    subRules
  };
}

function matchesSingleRule(productTitle, singleRule) {
  if (!productTitle || !singleRule || !singleRule.conceptGroups || !singleRule.conceptGroups.length) {
    return false;
  }
  const normalizedTitle = String(productTitle).toLowerCase().replace(/\s+/g, ' ').trim();
  const compactTitle = normalizedTitle.replace(/[\s\-_]/g, '');

  return singleRule.conceptGroups.every(group => {
    if (group.hasVersion && group.baseVariants.length > 0) {
      const directCombinedMatch = group.combinedVariants.some(cv =>
        compactTitle.includes(cv.replace(/[\s\-_]/g, ''))
      );
      if (directCombinedMatch) return true;

      const hasBase = group.baseVariants.some(b => normalizedTitle.includes(b));
      if (!hasBase) return false;

      return group.versionVariants.some(v => {
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('(?:^|[^a-z0-9가-힣])' + escaped + '(?:$|[^a-z0-9가-힣])', 'i');
        return regex.test(normalizedTitle);
      });
    }
    return group.baseVariants.some(b => normalizedTitle.includes(b)) ||
           group.combinedVariants.some(c => normalizedTitle.includes(c));
  });
}

function matchesKeywordRule(productTitle, parsedRule) {
  if (!productTitle || !parsedRule) return false;
  if (parsedRule.subRules && parsedRule.subRules.length > 0) {
    return parsedRule.subRules.some(sub => matchesSingleRule(productTitle, sub));
  }
  return matchesSingleRule(productTitle, parsedRule);
}

// ----------------------------------------------------------------------------
// 3. 크롤러 & 품절 감지 로직 (목록 카드 검사 + 상세 페이지 2차 검증)
// ----------------------------------------------------------------------------
const SOLDOUT_PATTERN = /품절|일시품절|재고\s*없음|판매\s*종료|sold\s*out|out\s*of\s*stock|icon_soldout|ico_soldout|btn_soldout|prod_soldout|soldout\.(?:gif|png|jpg|svg)|class=["'][^"']*sold[-_]?out/i;

async function fetchHtml(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8'
    }
  });

  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const buffer = Buffer.from(response.data);
  let html = iconv.decode(buffer, 'utf-8');

  if (contentType.includes('euc-kr') || /charset=["']?euc-kr/i.test(html)) {
    html = iconv.decode(buffer, 'euc-kr');
  }

  return { statusCode: response.status, html };
}

function extractProducts(html, baseUrl) {
  const sanitizedHtml = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const $ = cheerio.load(sanitizedHtml);
  $('script, style, noscript').remove();

  const products = [];
  const seenUrls = new Set();

  $('a[href]').each((_, el) => {
    const rawHref = ($(el).attr('href') || '').trim();
    if (!rawHref || rawHref.startsWith('javascript:') || rawHref.startsWith('#')) return;

    const text = ($(el).text() + ' ' + ($(el).find('img').attr('alt') || ''))
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < 4) return;

    const isLikelyProduct = /product|goods|shopdetail|item|view|detail|branduid|prd|no=|idx=/i.test(rawHref) ||
                            text.length >= 8;
    if (!isLikelyProduct) return;

    let fullUrl = rawHref;
    try {
      fullUrl = new URL(rawHref, baseUrl).href;
    } catch (e) {
      return;
    }

    if (seenUrls.has(fullUrl)) return;

    // 상품 카드 컨테이너(li, dl, tr, div.item 등) 전체 HTML에서 품절 텍스트/아이콘 이미지/클래스 탐지
    const cardContainer = $(el).closest('li, dl, tr, .item, .prd-item, .goods_item, .box');
    const cardHtml = cardContainer.length
      ? cardContainer.html()
      : ($(el).parent().parent().html() || $(el).parent().html() || '');

    const isSoldOut = SOLDOUT_PATTERN.test(cardHtml || '');

    seenUrls.add(fullUrl);
    products.push({ title: text, url: fullUrl, isSoldOut });
  });

  return products;
}

async function checkDetailPageSoldOut(productUrl) {
  try {
    const { statusCode, html } = await fetchHtml(productUrl);
    if (statusCode < 200 || statusCode >= 400) return false;
    
    // HTML 주석(<!--...-->) 먼저 제거 (쇼핑몰에서 재고 있을 때 품절 버튼을 주석 처리하는 패턴 방지)
    const sanitizedHtml = html.replace(/<!--[\s\S]*?-->/g, '');
    const $ = cheerio.load(sanitizedHtml);
    $('script, style, noscript').remove();
    const bodyHtml = $.html();

    const activeSoldOutBtn = /<(?:span|div|a|button|p)[^>]*class=["'](?![^"']*displaynone)[^"']*(?:soldout|sold_out|out-of-stock)[^"']*["'][^>]*>/i.test(bodyHtml);
    const explicitSoldOutText = /(?:현재\s*품절|품절된\s*상품|구매불가|재고가\s*없습니다|SOLD\s*OUT\s*된\s*상품)/i.test(bodyHtml);
    return activeSoldOutBtn || explicitSoldOutText;
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------------------------------
// 4. 웹훅 발송 (Discord / Telegram)
// ----------------------------------------------------------------------------
async function sendNotification(watch, alertType, product, site) {
  const badge = alertType === 'RESTOCK' ? '🟢 [재고 입고 알림]' : '🆕 [신상품 등록 알림]';
  const content = `${badge}\n• 유저: ${watch.userName}\n• 사이트: ${site.siteName}\n• 상품명: ${product.title}\n• 링크: ${product.url}`;

  if (watch.discordWebhook) {
    try {
      await axios.post(watch.discordWebhook, { username: '기어 스톡 알리미', content });
    } catch (e) {
      console.error('Discord 발송 오류:', e.message);
    }
  }

  if (watch.telegramBotToken && watch.telegramChatId) {
    try {
      const tgUrl = `https://api.telegram.org/bot${watch.telegramBotToken}/sendMessage`;
      await axios.post(tgUrl, { chat_id: watch.telegramChatId, text: content });
    } catch (e) {
      console.error('Telegram 발송 오류:', e.message);
    }
  }
}

async function runWatchScan(watch, isInitialScan = false) {
  const db = loadDb();
  const matched = [];

  for (const site of watch.sites) {
    try {
      const { statusCode, html } = await fetchHtml(site.siteUrl);
      if (statusCode < 200 || statusCode >= 400) continue;

      const products = extractProducts(html, site.siteUrl);
      for (const prod of products) {
        if (!matchesKeywordRule(prod.title, watch.parsedRule)) continue;

        let finalSoldOut = prod.isSoldOut;
        if (!finalSoldOut) {
          finalSoldOut = await checkDetailPageSoldOut(prod.url);
        }

        const key = `${watch.watchId}|${site.siteName}|${prod.url}`;
        const prev = db.snapshots[key];

        if (!prev) {
          db.snapshots[key] = {
            isSoldOut: finalSoldOut,
            title: prod.title,
            updatedAt: new Date().toISOString()
          };
          if (!finalSoldOut) {
            // 최초 등록 스캔(isInitialScan=true) 시에는 알림을 보내지 않고 기준선(Baseline)으로만 등록
            if (!isInitialScan) {
              await sendNotification(watch, 'NEW', prod, site);
              matched.push({ type: 'NEW', site: site.siteName, title: prod.title, url: prod.url });
            } else {
              matched.push({ type: 'BASELINE', site: site.siteName, title: prod.title, url: prod.url });
            }
          }
        } else {
          // 기존에 품절이었다가 구매가능으로 전환 시 재입고 알림
          if (prev.isSoldOut && !finalSoldOut) {
            await sendNotification(watch, 'RESTOCK', prod, site);
            matched.push({ type: 'RESTOCK', site: site.siteName, title: prod.title, url: prod.url });
          }
          db.snapshots[key].isSoldOut = finalSoldOut;
          db.snapshots[key].updatedAt = new Date().toISOString();
        }
      }
    } catch (e) {
      console.error(`[크롤링 오류] ${site.siteName}:`, e.message);
    }
  }

  saveDb(db);
  return matched;
}

cron.schedule('*/5 * * * *', async () => {
  const db = loadDb();
  for (const watch of db.watches) {
    await runWatchScan(watch);
  }
});

// ----------------------------------------------------------------------------
// 5. API 라우트 & 웹 UI
// ----------------------------------------------------------------------------
app.post('/api/preview-keywords', (req, res) => {
  const { rawKeywordsEn, rawKeywordsKo } = req.body;
  res.json(buildKeywordRules(rawKeywordsEn, rawKeywordsKo));
});

app.post('/api/verify-site', async (req, res) => {
  const { siteName, siteUrl } = req.body;
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) {
    return res.json({ ok: false, message: '서비스 불가능한 사이트 입니다', detail: '유효하지 않은 URL입니다.' });
  }

  try {
    const { statusCode, html } = await fetchHtml(siteUrl);
    if (statusCode < 200 || statusCode >= 400) {
      return res.json({ ok: false, message: '서비스 불가능한 사이트 입니다', detail: `HTTP 상태 코드 ${statusCode}` });
    }
    if (/cf-browser-verification|Attention Required! \| Cloudflare|captcha|접근이 차단/i.test(html)) {
      return res.json({ ok: false, message: '서비스 불가능한 사이트 입니다', detail: '보안/봇 차단 감지됨' });
    }
    const products = extractProducts(html, siteUrl);
    if (products.length < 2) {
      return res.json({ ok: false, message: '서비스 불가능한 사이트 입니다', detail: 'CSR(동적 렌더링) 전용이거나 상품 링크 없음' });
    }
    res.json({
      ok: true,
      siteName: siteName || new URL(siteUrl).hostname,
      siteUrl,
      message: `크롤링 가능 사이트 확인 완료 (탐지된 링크 ${products.length}개)`
    });
  } catch (e) {
    res.json({ ok: false, message: '서비스 불가능한 사이트 입니다', detail: e.message });
  }
});

app.post('/api/watches', async (req, res) => {
  const { userName, discordWebhook, telegramBotToken, telegramChatId, rawKeywordsEn, rawKeywordsKo, sites } = req.body;
  const parsedRule = buildKeywordRules(rawKeywordsEn, rawKeywordsKo);
  const watch = {
    watchId: 'W_' + Date.now(),
    userName,
    discordWebhook,
    telegramBotToken,
    telegramChatId,
    rawKeywordsEn,
    rawKeywordsKo,
    parsedRule,
    sites,
    createdAt: new Date().toISOString()
  };

  const db = loadDb();
  db.watches.push(watch);
  saveDb(db);

  const initialMatches = await runWatchScan(watch, true);
  res.json({
    ok: true,
    watchId: watch.watchId,
    expandedKeywords: parsedRule.allExpandedKeywords,
    baselineMatches: initialMatches,
    baselineCount: initialMatches.length
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>홈서버 상품 크롤링 모니터</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Pretendard", sans-serif; background:#f8fafc; padding:24px; color:#0f172a; }
    .container { max-width: 720px; margin: 0 auto; }
    .tip-banner { background:#eff6ff; border:1px solid #bfdbfe; color:#1e3a8a; border-radius:10px; padding:12px 14px; font-size:0.86rem; line-height:1.55; margin-bottom:16px; }
    .card { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px; margin-bottom:16px; }
    .helper-desc { font-size:0.83rem; color:#64748b; margin-bottom:10px; line-height:1.45; }
    input { width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:8px; margin-bottom:10px; box-sizing:border-box; }
    .row { display:flex; gap:8px; }
    button { padding:10px 16px; border:none; border-radius:8px; background:#2563eb; color:#fff; font-weight:600; cursor:pointer; white-space:nowrap; }
    .error { color:#dc2626; font-weight:600; margin-top:6px; }
    .ok { color:#16a34a; font-weight:600; margin-top:6px; }
    .tag { display:inline-block; background:#eff6ff; color:#1d4ed8; padding:4px 10px; border-radius:999px; font-size:0.82rem; margin:3px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎸 멀티 쇼핑몰 신상품 & 재입고 모니터 (Node.js)</h1>
    <div class="tip-banner">
      💡 <strong>권장 등록 팁:</strong> 실제 감시할 쇼핑몰에 등록하실 때는 각 쇼핑몰의 전체 메인 주소(홈페이지 루트)보다
      <strong>브랜드 카테고리 페이지</strong>나 <strong>특정 모델(예: <code>jaguar</code>) 검색 결과 페이지 URL</strong>을 넣으시면 훨씬 빠르고 정확하게 신상품과 재입고를 감지할 수 있습니다.
    </div>
    <div class="card">
      <h3>1. 유저 및 디스코드/텔레그램 웹훅 등록</h3>
      <input id="userName" placeholder="유저 이름" />
      <input id="discordWebhook" placeholder="Discord Webhook URL" />
      <div class="row">
        <input id="telegramBotToken" placeholder="Telegram Bot Token" />
        <input id="telegramChatId" placeholder="Telegram Chat ID" />
      </div>
    </div>
    <div class="card">
      <h3>2. 상품 키워드 등록 (한/영 파생 키워드 자동 확장)</h3>
      <input id="keywordsEn" placeholder="영문 키워드 (예: fender vinteraiii jaguar)" oninput="previewKw()" />
      <input id="keywordsKo" placeholder="한글 키워드 (예: 펜더 빈테라3 재규어)" oninput="previewKw()" />
      <div id="kwPreview"></div>
    </div>
    <div class="card">
      <h3>3. 웹사이트 등록 (실시간 크롤링 가능 여부 확인)</h3>
      <div class="helper-desc">
        ※ 쇼핑몰 메인 주소 대신 <strong>브랜드별 카테고리 목록 URL</strong> 또는 <strong>검색 결과 페이지 URL</strong>을 입력해 주세요. [등록] 클릭 시 즉시 크롤링 가능 여부를 테스트합니다.
      </div>
      <div class="row">
        <input id="siteName" placeholder="사이트명 (musicforce)" style="max-width:180px;" />
        <input id="siteUrl" placeholder="https://..." />
        <button onclick="verifySite()">등록</button>
      </div>
      <div id="siteMsg"></div>
      <ul id="siteList"></ul>
    </div>
    <button style="width:100%; padding:14px;" onclick="submitWatch()">🚀 모니터링 시작</button>
    <div id="finalMsg"></div>
  </div>
  <script>
    const sites = [];
    async function previewKw() {
      const r = await fetch('/api/preview-keywords', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rawKeywordsEn: keywordsEn.value, rawKeywordsKo: keywordsKo.value })
      }).then(r => r.json());
      kwPreview.innerHTML = (r.allExpandedKeywords || []).map(k => '<span class="tag">' + k + '</span>').join('');
    }
    async function verifySite() {
      siteMsg.textContent = '크롤링 테스트 중...';
      const r = await fetch('/api/verify-site', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ siteName: siteName.value, siteUrl: siteUrl.value })
      }).then(r => r.json());
      if (!r.ok) {
        siteMsg.className = 'error';
        siteMsg.textContent = '❌ ' + r.message + ' (' + r.detail + ')';
        alert(r.message);
        return;
      }
      siteMsg.className = 'ok';
      siteMsg.textContent = '✅ ' + r.message;
      sites.push({ siteName: r.siteName, siteUrl: r.siteUrl });
      siteList.innerHTML = sites.map(s => '<li><b>[' + s.siteName + ']</b> ' + s.siteUrl + '</li>').join('');
      siteName.value = ''; siteUrl.value = '';
    }
    async function submitWatch() {
      const r = await fetch('/api/watches', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          userName: userName.value, discordWebhook: discordWebhook.value,
          telegramBotToken: telegramBotToken.value, telegramChatId: telegramChatId.value,
          rawKeywordsEn: keywordsEn.value, rawKeywordsKo: keywordsKo.value, sites
        })
      }).then(r => r.json());
      if (r.ok) {
        finalMsg.className = 'ok';
        finalMsg.textContent = '등록 완료! 확장 키워드: ' + r.expandedKeywords.join(', ');
      }
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Product Monitor Server running on http://localhost:${PORT}`);
});