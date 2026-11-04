/**
 * ============================================================================
 * [Google Apps Script] 다중 쇼핑몰 신상품 & 재입고 크롤링 모니터 (Code.gs)
 * ============================================================================
 *
 * [설치 및 실행 방법 - 기본 GAS 웹앱 배포]
 * 1. Google Sheets(구글 스프레드시트) 새 문서를 하나 생성합니다.
 * 2. 상단 메뉴 [확장 프로그램] -> [Apps Script]를 클릭합니다.
 * 3. 기존 코드를 모두 지우고 이 파일(gas_product_monitor.js)의 내용을 그대로 붙여넣고 저장(Ctrl+S)합니다.
 * 4. 상단 함수 선택 드롭다운에서 `setupTrigger`를 선택한 뒤 [실행] 버튼을 눌러
 *    권한을 승인하고 10분 주기 자동 크롤링 트리거를 등록합니다.
 * 5. 우측 상단 [배포] -> [새 배포] -> 유형: [웹 앱(Web App)] 선택
 *    - 다음 사용자로 실행: 나(Me)
 *    - 액세스 권한이 있는 사용자: 모든 사용자(Anyone)  <-- github.io 연동 시 필수!
 * 6. 생성된 웹 앱 URL로 접속하거나, HTML만 추출해 github.io(GitHub Pages)에 올려서 사용할 수 있습니다.
 */

const SHEET_USERS = 'Users';
const SHEET_WATCHES = 'Watches';
const SHEET_SNAPSHOTS = 'Snapshots';

/**
 * 1-A. 웹 앱 GET 진입점 (단일 파일로 동작하도록 HTML 템플릿 내장)
 */
function doGet() {
  initSheets_();
  return HtmlService.createHtmlOutput(getHtmlTemplate_())
    .setTitle('상품 입고 & 신상품 크롤링 모니터')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 1-B. GitHub Pages(github.io) 등 외부 정적 웹페이지 연동을 위한 POST API 진입점
 * - 브라우저 CORS Preflight(OPTIONS) 차단을 우회하기 위해
 *   클라이언트에서 Content-Type: text/plain;charset=utf-8 로 보낸 JSON을 파싱합니다.
 */
function doPost(e) {
  initSheets_();
  let result = { ok: false, message: '알 수 없는 요청입니다.' };

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;

    if (action === 'previewKeywordExpansion') {
      result = previewKeywordExpansion(body.rawKeywordsEn, body.rawKeywordsKo);
    } else if (action === 'verifyWebsiteCrawlable') {
      result = verifyWebsiteCrawlable(body.siteName, body.siteUrl);
    } else if (action === 'testWebhookConnection') {
      result = testWebhookConnection(body.discordWebhook, body.telegramBotToken, body.telegramChatId);
    } else if (action === 'saveUserAndWatch') {
      result = saveUserAndWatch(body.payload);
    }
  } catch (err) {
    result = { ok: false, message: '서버 처리 오류: ' + err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 2. 구글 시트(데이터베이스 역할) 초기화
 */
function initSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('구글 스프레드시트 내부의 [확장 프로그램 > Apps Script]에서 실행해 주세요.');
  }

  let userSheet = ss.getSheetByName(SHEET_USERS);
  if (!userSheet) {
    userSheet = ss.insertSheet(SHEET_USERS);
    userSheet.appendRow(['userId', 'userName', 'discordWebhook', 'telegramBotToken', 'telegramChatId', 'updatedAt']);
  }

  let watchSheet = ss.getSheetByName(SHEET_WATCHES);
  if (!watchSheet) {
    watchSheet = ss.insertSheet(SHEET_WATCHES);
    watchSheet.appendRow([
      'watchId',
      'userId',
      'productLabel',
      'rawKeywordsKo',
      'rawKeywordsEn',
      'parsedRuleJson',
      'sitesJson',
      'createdAt',
      'lastCheckedAt'
    ]);
  }

  let snapSheet = ss.getSheetByName(SHEET_SNAPSHOTS);
  if (!snapSheet) {
    snapSheet = ss.insertSheet(SHEET_SNAPSHOTS);
    snapSheet.appendRow(['snapshotKey', 'watchId', 'siteName', 'productTitle', 'productUrl', 'isSoldOut', 'updatedAt']);
  }
}

/**
 * 3. 주기적 크롤링 트리거 등록 (최초 1회 실행)
 */
function setupTrigger() {
  initSheets_();
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'runScheduledCrawl') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runScheduledCrawl')
    .timeBased()
    .everyMinutes(10)
    .create();
}

/**
 * ============================================================================
 * [핵심 로직 1] 한/영 상품 키워드 파싱 및 경우의 수 확장 엔진
 * Ex) "fender vinteraiii jaguar" / "펜더 빈테라3 재규어"
 *  -> Concept 그룹별로 분리 후 로마자(i~x) <-> 아라비아 숫자(1~10),
 *     붙여쓰기/띄어쓰기/하이픈 조합(vintera, iii, 3, vintera3, vinteraiii 등)을 생성하고
 *     모든 개념 그룹이 매칭되는지 검증합니다.
 * ============================================================================
 */
const ROMAN_TO_NUM = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5',
  vi: '6', vii: '7', viii: '8', ix: '9', x: '10'
};
const NUM_TO_ROMAN = {
  '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v',
  '6': 'vi', '7': 'vii', '8': 'viii', '9': 'ix', '10': 'x'
};

// 자주 쓰이는 악기/브랜드 한영 기본 사전 (사용자가 한쪽만 입력해도 보조 매칭 지원)
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
  '깁슨': ['gibson', '깁슨'],
  custom: ['custom', '커스텀'],
  '커스텀': ['custom', '커스텀']
};

/**
 * 단일 토큰을 분석하여 접미 로마자/숫자 분리 및 다양한 파생 키워드 생성
 */
function expandSingleToken_(rawToken) {
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

  const baseSynonyms = basePart
    ? (BUILTIN_SYNONYMS[basePart] || [basePart])
    : [];

  const versionVariants = [];
  if (numPart) {
    const roman = NUM_TO_ROMAN[numPart];
    versionVariants.push(numPart);
    if (roman && !versionVariants.includes(roman)) {
      versionVariants.push(roman);
    }
  }

  const combinedVariants = new Set();
  const displayKeywords = new Set();

  baseSynonyms.forEach(b => displayKeywords.add(b));
  versionVariants.forEach(v => displayKeywords.add(v));

  if (baseSynonyms.length > 0 && versionVariants.length > 0) {
    baseSynonyms.forEach(b => {
      versionVariants.forEach(v => {
        combinedVariants.add(b + v);        // vinteraiii, vintera3, 빈테라3
        combinedVariants.add(b + ' ' + v);  // vintera iii, vintera 3
        combinedVariants.add(b + '-' + v);  // vintera-iii, vintera-3
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

/**
 * 단일 문장 키워드를 받아 conceptGroups 규칙 생성
 */
function buildSingleKeywordRule_(rawKeywordsEn, rawKeywordsKo) {
  const enTokens = String(rawKeywordsEn || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const koTokens = String(rawKeywordsKo || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const mergeVersionTokens = (tokens) => {
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

  const normEn = mergeVersionTokens(enTokens);
  const normKo = mergeVersionTokens(koTokens);
  const maxLen = Math.max(normEn.length, normKo.length);

  const conceptGroups = [];
  const allExpandedFlat = new Set();

  for (let i = 0; i < maxLen; i++) {
    const enExp = normEn[i] ? expandSingleToken_(normEn[i]) : null;
    const koExp = normKo[i] ? expandSingleToken_(normKo[i]) : null;

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
    conceptGroups: conceptGroups
  };
}

/**
 * 사용자의 한글/영문 키워드 입력을 받아 검색 규칙(Rule) 객체 생성
 * - 세미콜론(;), 줄바꿈(\n), 파이프(|) 구분자를 지원하여 여러 상품 키워드 묶음(OR 조건)을 생성합니다.
 */
function buildKeywordRules(rawKeywordsEn, rawKeywordsKo) {
  const splitClauses = (str) => {
    return String(str || '')
      .split(/[;\n|]+/)
      .map(s => s.trim())
      .filter(Boolean);
  };

  const enClauses = splitClauses(rawKeywordsEn);
  const koClauses = splitClauses(rawKeywordsKo);
  const maxClauses = Math.max(enClauses.length, koClauses.length, 1);

  const subRules = [];
  const globalExpanded = new Set();

  for (let c = 0; c < maxClauses; c++) {
    const en = enClauses[c] || (enClauses.length === 1 ? enClauses[0] : '');
    const ko = koClauses[c] || (koClauses.length === 1 ? koClauses[0] : '');
    if (!en && !ko) continue;

    const single = buildSingleKeywordRule_(en, ko);
    single.allExpandedKeywords.forEach(k => globalExpanded.add(k));
    subRules.push(single);
  }

  return {
    rawKeywordsEn: rawKeywordsEn || '',
    rawKeywordsKo: rawKeywordsKo || '',
    allExpandedKeywords: Array.from(globalExpanded),
    conceptGroups: subRules[0] ? subRules[0].conceptGroups : [],
    subRules: subRules
  };
}

/**
 * 단일 규칙 매칭 검사
 */
function matchesSingleRule_(productTitle, singleRule) {
  if (!productTitle || !singleRule || !singleRule.conceptGroups || singleRule.conceptGroups.length === 0) {
    return false;
  }

  const normalizedTitle = String(productTitle).toLowerCase().replace(/\s+/g, ' ').trim();
  const compactTitle = normalizedTitle.replace(/[\s\-_]/g, '');

  return singleRule.conceptGroups.every(group => {
    if (group.hasVersion && group.baseVariants.length > 0) {
      const directCombinedMatch = group.combinedVariants.some(cv => {
        const cleanCv = cv.replace(/[\s\-_]/g, '');
        return compactTitle.includes(cleanCv);
      });
      if (directCombinedMatch) return true;

      const hasBase = group.baseVariants.some(b => normalizedTitle.includes(b));
      if (!hasBase) return false;

      const hasVersionToken = group.versionVariants.some(v => {
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('(?:^|[^a-z0-9가-힣])' + escaped + '(?:$|[^a-z0-9가-힣])', 'i');
        return regex.test(normalizedTitle);
      });
      return hasVersionToken;
    }

    return group.baseVariants.some(b => normalizedTitle.includes(b)) ||
           group.combinedVariants.some(c => normalizedTitle.includes(c));
  });
}

/**
 * 상품명이 확장된 키워드 조건(Rule)에 부합하는지 확인 (다중 subRules OR 조건 지원)
 */
function matchesKeywordRule(productTitle, parsedRule) {
  if (!productTitle || !parsedRule) return false;

  if (parsedRule.subRules && parsedRule.subRules.length > 0) {
    return parsedRule.subRules.some(sub => matchesSingleRule_(productTitle, sub));
  }

  return matchesSingleRule_(productTitle, parsedRule);
}

function previewKeywordExpansion(rawKeywordsEn, rawKeywordsKo) {
  return buildKeywordRules(rawKeywordsEn, rawKeywordsKo);
}

/**
 * ============================================================================
 * [핵심 로직 2] 웹사이트 크롤링 가능 여부 실시간 검증 & 품절 감지 파서
 * ============================================================================
 */
function fetchHtmlWithEncoding_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  const statusCode = response.getResponseCode();
  const headers = response.getAllHeaders();
  const contentType = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();

  let html = response.getContentText('UTF-8');
  if (contentType.includes('euc-kr') || /charset=["']?euc-kr/i.test(html)) {
    html = response.getContentText('euc-kr');
  }

  return {
    statusCode: statusCode,
    html: html
  };
}

/**
 * 스크립트/스타일/주석 제거 전처리
 * - 반드시 <script>, <style>을 먼저 제거한 뒤 HTML 주석(<!--...-->)을 제거해야
 *   <script> 내부의 '<!--' 문자열이 본문 HTML까지 삼키는 현상을 방지할 수 있습니다.
 */
function stripNoiseFromHtml_(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 비활성(displaynone, display:none 등) 숨김 요소 제거
 */
function stripHiddenElements_(htmlChunk) {
  return String(htmlChunk || '')
    .replace(/<([a-z0-9]+)\b[^>]*(?:class=["'][^"']*\b(?:displaynone|dn|d-none|hidden|hide)\b[^"']*["']|style=["'][^"']*display\s*:\s*none[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi, '');
}

/**
 * 상대경로(../, ./, /) 및 기존 저장된 URL의 dot-segment(../)를 표준 절대 URL로 정규화
 * Ex) baseUrl: https://www.buzzbee.co.kr/goods/goods_search.php?keyword=jaguar
 *     rawHref: ../goods/goods_view.php?goodsNo=29755
 *  -> https://www.buzzbee.co.kr/goods/goods_view.php?goodsNo=29755
 */
function resolveProductUrl_(rawHref, baseUrl) {
  const href = String(rawHref || '').trim();
  const base = String(baseUrl || '').trim();
  if (!href) return '';

  let targetUrl = href;
  if (href.startsWith('//')) {
    const schemeMatch = base.match(/^(https?:)/i);
    targetUrl = (schemeMatch ? schemeMatch[1] : 'https:') + href;
  } else if (!/^https?:\/\//i.test(href)) {
    const originMatch = base.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i);
    if (!originMatch) return href;
    const origin = originMatch[1];
    const basePath = originMatch[2] || '/';
    if (href.startsWith('/')) {
      targetUrl = origin + href;
    } else {
      const baseDir = basePath.replace(/\/[^/]*$/, '/');
      targetUrl = origin + baseDir + href;
    }
  }

  targetUrl = targetUrl.replace(/#.*$/, '');
  const fullMatch = targetUrl.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?(\?.*)?$/i);
  if (!fullMatch) return targetUrl;

  const origin = fullMatch[1];
  const pathPart = fullMatch[2] || '/';
  const queryPart = fullMatch[3] || '';

  const segments = pathPart.split('/');
  const resolved = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  return origin + '/' + resolved.join('/') + queryPart;
}

/**
 * [품절 여부 판단 로직 - 1단계: 상품 목록 카드 컨텍스트 검사]
 * 한국 쇼핑몰(카페24, 메이크샵, 고도몰5/버즈비 등)의 품절 표시 패턴을 모두 검사합니다:
 * 1) 한글/영문 텍스트: 품절, 일시품절, 재고없음, 판매종료, SOLD OUT, Out of stock, 재입고 알림
 * 2) 품절 아이콘 이미지 파일명/속성: icon_soldout, soldout_icon, btn_soldout, ico_soldout, prod_soldout, alt="품절"
 * 3) CSS 클래스/상태값: btn_add_soldout, btn_restock_box, soldout, out-of-stock
 */
const SOLDOUT_PATTERN = /품절|일시품절|재고\s*없음|판매\s*종료|sold\s*out|out\s*of\s*stock|icon_soldout|ico_soldout|btn_soldout|prod_soldout|soldout_icon|sold[-_]?out[-_]?icon|btn_add_soldout|btn_restock_box|btn_restock_notice|btn_add_restock|재입고\s*알림|soldout\.(?:gif|png|jpg|svg)|class=["'][^"']*sold[-_]?out/i;

function isChunkSoldOut_(htmlChunk) {
  const visibleChunk = stripHiddenElements_(htmlChunk);
  return SOLDOUT_PATTERN.test(visibleChunk);
}

/**
 * 상품 <a> 태그 그룹을 감싸는 개별 상품 카드 컨테이너(<li>, <tr>, <dl> 또는 카드 <div>) 추출
 * - 고도몰(버즈비 등)처럼 썸네일 <a>와 하단 .item_icon_box(품절 아이콘) 사이 거리가 700자 이상 떨어진 구조도
 *   <li>...</li> 전체 카드를 정확히 추출하여 누락 없이 감지합니다.
 * - 카페24처럼 카드 내부에 중첩 <ul class="spec"><li>...</li></ul>가 있는 경우에도 태그 깊이(depth)를 계산해
 *   외곽 상품 <li>가 닫히는 지점까지 안전하게 추출합니다.
 */
function findEnclosingContainer_(cleanHtml, prevEnd, groupStart, groupEnd, nextStart) {
  const searchStart = Math.max(prevEnd, groupStart - 800);
  const beforeRegion = cleanHtml.substring(searchStart, groupStart);
  const tagRegex = /<\/?(li|tr|dl)\b[^>]*>/gi;
  const stack = [];
  let m;

  while ((m = tagRegex.exec(beforeRegion)) !== null) {
    const isClose = /^<\//.test(m[0]);
    const tag = m[1].toLowerCase();
    if (isClose) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tag === tag) {
          stack.splice(s, 1);
          break;
        }
      }
    } else {
      stack.push({ tag: tag, idx: searchStart + m.index });
    }
  }

  const maxLookahead = Math.min(cleanHtml.length, groupEnd + 1800);

  if (stack.length > 0) {
    const outer = stack[0];
    const closeMatcher = new RegExp('<\\/?' + outer.tag + '\\b[^>]*>', 'gi');
    closeMatcher.lastIndex = outer.idx;
    let depth = 0;
    let cm;
    while ((cm = closeMatcher.exec(cleanHtml)) !== null) {
      if (cm.index >= maxLookahead) break;
      if (/^<\//.test(cm[0])) {
        depth--;
        if (depth <= 0) {
          return cleanHtml.substring(outer.idx, cm.index + cm[0].length);
        }
      } else {
        depth++;
      }
    }
    return cleanHtml.substring(outer.idx, Math.min(nextStart, maxLookahead));
  }

  // <li>/<tr>/<dl>이 아닌 <div> 기반 상품 카드 폴백
  const divOpenRegex = /<div\b[^>]*class=["'][^"']*(?:item_cont|prd-item|goods_item|item_box|prd_box|list_item|item)[^"']*["'][^>]*>/gi;
  let cardStart = Math.max(prevEnd, groupStart - 180);
  let dm;
  while ((dm = divOpenRegex.exec(beforeRegion)) !== null) {
    cardStart = searchStart + dm.index;
  }

  const boundEnd = Math.min(nextStart, maxLookahead);
  const afterRegion = cleanHtml.substring(groupEnd, boundEnd);
  let cardEnd = boundEnd;
  if (nextStart <= groupEnd + 1800) {
    let lastNextDiv = null;
    divOpenRegex.lastIndex = 0;
    let nm;
    while ((nm = divOpenRegex.exec(afterRegion)) !== null) {
      lastNextDiv = nm.index;
    }
    if (lastNextDiv !== null) {
      cardEnd = groupEnd + lastNextDiv;
    }
  }
  return cleanHtml.substring(cardStart, cardEnd);
}

/**
 * [품절 여부 판단 로직 - 2단계: 키워드 매칭된 상품의 상세 페이지 교차 검증]
 * - 반환값:
 *   true  -> 상세 페이지에서 품절 확인됨
 *   false -> 상세 페이지 정상 로드 완료 및 품절 표시 없음(구매 가능)
 *   null  -> 네트워크/HTTP 오류로 판단 불가 (기존 스냅샷 상태 유지용)
 */
function checkDetailPageSoldOut_(productUrl) {
  try {
    const normalizedUrl = resolveProductUrl_(productUrl, '');
    const res = fetchHtmlWithEncoding_(normalizedUrl || productUrl);
    if (res.statusCode < 200 || res.statusCode >= 400) return null;

    const cleanDetail = stripHiddenElements_(stripNoiseFromHtml_(res.html));

    // 1) 활성 품절/재입고알림 클래스 (고도몰 btn_add_soldout, btn_restock_box, 카페24/메이크샵 soldout 등)
    const activeSoldOutClass = /<(?:span|div|a|button|p|li|em|strong|input)\b[^>]*class=["'](?![^"']*displaynone)[^"']*(?:soldout|sold_out|out-of-stock|btn_add_soldout|btn_restock_box|btn_restock_notice|btn_add_restock)[^"']*["'][^>]*>/i.test(cleanDetail);

    // 2) 버튼/배지 태그 내부 단독 품절/재입고알림 문구 (예: <button type="button" class="btn_add_soldout" disabled="disabled">품절</button>)
    const activeSoldOutTagText = /<(?:button|a|span|p|em|strong)\b[^>]*>\s*(?:품절|일시품절|SOLD\s*OUT|OUT\s*OF\s*STOCK|재고\s*없음|판매\s*종료|구매\s*불가|재입고\s*알림(?:\s*신청)?)\s*<\/(?:button|a|span|p|em|strong)>/i.test(cleanDetail);

    // 3) 상세 페이지 명시적 품절 안내 문구
    const explicitSoldOutText = /(?:현재\s*품절|품절된\s*상품|구매불가|재고가\s*없습니다|SOLD\s*OUT\s*된\s*상품|재입고\s*알림\s*신청|재입고알림)/i.test(cleanDetail);

    return activeSoldOutClass || activeSoldOutTagText || explicitSoldOutText;
  } catch (e) {
    return null;
  }
}

/**
 * HTML에서 상품 링크 및 품절 여부 추출
 */
function extractProductsFromHtml_(html, baseUrl) {
  const cleanHtml = stripNoiseFromHtml_(html);
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const rawAnchors = [];
  let match;

  while ((match = anchorRegex.exec(cleanHtml)) !== null) {
    const rawHref = match[1].trim();
    if (!rawHref || rawHref.startsWith('javascript:') || rawHref.startsWith('#')) continue;

    const textOnly = match[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();

    const innerText = match[2]
      .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();

    if (innerText.length < 4) continue;

    const isLikelyProductLink = /product|goods|shopdetail|item|view|detail|branduid|prd|no=|idx=/i.test(rawHref) ||
                                innerText.length >= 8;

    if (!isLikelyProductLink) continue;

    const fullUrl = resolveProductUrl_(rawHref, baseUrl);
    if (!fullUrl) continue;

    rawAnchors.push({
      start: match.index,
      end: match.index + match[0].length,
      fullUrl: fullUrl,
      title: textOnly.length >= 4 ? textOnly : innerText,
      hasDirectText: textOnly.length >= 4
    });
  }

  // 한 상품 카드 내의 연속된 동일 URL 링크(예: .item_photo_box 썸네일 <a> + .item_tit_box 상품명 <a>)를 하나의 그룹으로 병합
  const cardGroups = [];
  for (let i = 0; i < rawAnchors.length; i++) {
    const curr = rawAnchors[i];
    const prevGroup = cardGroups.length > 0 ? cardGroups[cardGroups.length - 1] : null;
    if (prevGroup && prevGroup.fullUrl === curr.fullUrl && (curr.start - prevGroup.end) < 1200) {
      prevGroup.end = curr.end;
      if (curr.hasDirectText && (!prevGroup.hasDirectText || curr.title.length >= prevGroup.title.length)) {
        prevGroup.title = curr.title;
        prevGroup.hasDirectText = true;
      }
    } else {
      cardGroups.push({
        start: curr.start,
        end: curr.end,
        fullUrl: curr.fullUrl,
        title: curr.title,
        hasDirectText: curr.hasDirectText
      });
    }
  }

  const products = [];
  const productMap = {};

  for (let i = 0; i < cardGroups.length; i++) {
    const group = cardGroups[i];
    const prevEnd = i > 0 ? cardGroups[i - 1].end : 0;
    const nextStart = i + 1 < cardGroups.length ? cardGroups[i + 1].start : cleanHtml.length;

    const surroundingChunk = findEnclosingContainer_(cleanHtml, prevEnd, group.start, group.end, nextStart);
    const isSoldOut = isChunkSoldOut_(surroundingChunk);

    // 페이지 내 다른 영역(예: '오늘 본 상품' 사이드바 등)과 본문 상품 목록에 동일 URL이 중복 등장할 경우
    // 어느 한 곳이라도 품절 배지가 감지되면 true로 반영
    if (productMap[group.fullUrl]) {
      if (isSoldOut) {
        productMap[group.fullUrl].isSoldOut = true;
      }
      if (group.hasDirectText && group.title.length >= productMap[group.fullUrl].title.length) {
        productMap[group.fullUrl].title = group.title;
      }
    } else {
      const item = {
        title: group.title,
        url: group.fullUrl,
        isSoldOut: isSoldOut
      };
      productMap[group.fullUrl] = item;
      products.push(item);
    }
  }

  return products;
}

/**
 * [요구사항 4] 웹사이트 입력 창에서 "등록" 버튼 눌렀을 때 크롤링 가능 여부 테스트
 */
function verifyWebsiteCrawlable(siteName, siteUrl) {
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl.trim())) {
    return {
      ok: false,
      message: '서비스 불가능한 사이트 입니다',
      detail: '올바른 URL 형식(http:// 또는 https://)이 아닙니다.'
    };
  }

  try {
    const res = fetchHtmlWithEncoding_(siteUrl.trim());
    const code = res.statusCode;
    const html = res.html || '';

    if (code < 200 || code >= 400) {
      return {
        ok: false,
        message: '서비스 불가능한 사이트 입니다',
        detail: 'HTTP 응답 오류 (상태 코드: ' + code + ')'
      };
    }

    const isBlocked = /cf-browser-verification|Attention Required! \| Cloudflare|captcha|접근이 차단|자동화된 요청/i.test(html);
    if (isBlocked) {
      return {
        ok: false,
        message: '서비스 불가능한 사이트 입니다',
        detail: '보안 솔루션(Cloudflare/Captcha)에 의해 크롤링이 차단된 사이트입니다.'
      };
    }

    const extracted = extractProductsFromHtml_(html, siteUrl.trim());
    if (extracted.length < 2) {
      return {
        ok: false,
        message: '서비스 불가능한 사이트 입니다',
        detail: '자바스크립트 동적 렌더링 전용 사이트이거나 상품 목록을 추출할 수 없습니다.'
      };
    }

    return {
      ok: true,
      siteName: siteName || extractDomainName_(siteUrl),
      siteUrl: siteUrl.trim(),
      sampleCount: extracted.length,
      sampleTitles: extracted.slice(0, 3).map(p => p.title),
      message: '크롤링 가능 사이트 확인 완료 (탐지된 항목: ' + extracted.length + '개)'
    };
  } catch (err) {
    return {
      ok: false,
      message: '서비스 불가능한 사이트 입니다',
      detail: '접속 실패 또는 타임아웃: ' + err.message
    };
  }
}

function extractDomainName_(url) {
  const m = String(url).match(/^https?:\/\/(?:www\.)?([^/:]+)/i);
  return m ? m[1] : 'Site';
}

/**
 * ============================================================================
 * [핵심 로직 3] 유저/웹훅 등록 & 워치 리스트 저장 및 알림 발송
 * ============================================================================
 */
function saveUserAndWatch(payload) {
  initSheets_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  const watchSheet = ss.getSheetByName(SHEET_WATCHES);

  const now = new Date().toISOString();
  const userId = payload.userName.trim().toLowerCase().replace(/\s+/g, '_');

  // 동일한 유저가 있을 경우 정보를 갱신하고, 없을 경우 신규 추가
  const userData = userSheet.getDataRange().getValues();
  let userRow = -1;
  for (let i = 1; i < userData.length; i++) {
    if (userData[i][0] === userId) {
      userRow = i + 1;
      break;
    }
  }

  const userRowValues = [
    userId,
    payload.userName.trim(),
    payload.discordWebhook || '',
    payload.telegramBotToken || '',
    payload.telegramChatId || '',
    now
  ];

  if (userRow > 0) {
    userSheet.getRange(userRow, 1, 1, 6).setValues([userRowValues]);
  } else {
    userSheet.appendRow(userRowValues);
  }

  const parsedRule = buildKeywordRules(payload.rawKeywordsEn, payload.rawKeywordsKo);
  const watchId = 'W_' + new Date().getTime();

  watchSheet.appendRow([
    watchId,
    userId,
    payload.productLabel || (payload.rawKeywordsEn + ' ' + payload.rawKeywordsKo).trim(),
    payload.rawKeywordsKo || '',
    payload.rawKeywordsEn || '',
    JSON.stringify(parsedRule),
    JSON.stringify(payload.sites || []),
    now,
    ''
  ]);

  // 최초 등록 시 알림 폭탄 방지: 기존에 존재하는 상품들은 기준선(Baseline)으로만 등록하고 알림은 보내지 않음
  const scanSummary = runCrawlForWatch_(
    watchId,
    payload.userName.trim(),
    payload.discordWebhook,
    payload.telegramBotToken,
    payload.telegramChatId,
    parsedRule,
    payload.sites || [],
    true // isInitialScan = true
  );

  return {
    ok: true,
    watchId: watchId,
    expandedKeywords: parsedRule.allExpandedKeywords,
    scanSummary: scanSummary,
    baselineCount: scanSummary.length
  };
}

function sendWebhookNotification_(userConfig, alertTitle, product, site) {
  const statusBadge = alertTitle.includes('재고') ? '🟢 [재입고 감지]' : '🆕 [신상품 등록]';
  const textMsg =
    statusBadge + ' ' + alertTitle + '\n' +
    '• 사이트: ' + site.siteName + '\n' +
    '• 상품명: ' + product.title + '\n' +
    '• 링크: ' + product.url;

  if (userConfig.discordWebhook && /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(userConfig.discordWebhook)) {
    try {
      UrlFetchApp.fetch(userConfig.discordWebhook, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          username: '기어 스톡 알리미',
          content: textMsg
        }),
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log('Discord 발송 실패: ' + e.message);
    }
  }

  if (userConfig.telegramBotToken && userConfig.telegramChatId) {
    try {
      const tgUrl = 'https://api.telegram.org/bot' + userConfig.telegramBotToken.trim() + '/sendMessage';
      UrlFetchApp.fetch(tgUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: userConfig.telegramChatId.trim(),
          text: textMsg,
          disable_web_page_preview: false
        }),
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log('Telegram 발송 실패: ' + e.message);
    }
  }
}

function testWebhookConnection(discordWebhook, telegramBotToken, telegramChatId) {
  sendWebhookNotification_(
    {
      discordWebhook: discordWebhook,
      telegramBotToken: telegramBotToken,
      telegramChatId: telegramChatId
    },
    '웹훅 연동 테스트 알림입니다',
    { title: 'Fender Vintera III Jaguar (테스트 상품)', url: 'https://example.com' },
    { siteName: '테스트 사이트' }
  );
  return { ok: true, message: '테스트 알림을 전송했습니다. 디스코드/텔레그램을 확인해 주세요.' };
}

/**
 * 시트의 isSoldOut 셀 값(불리언 또는 사용자가 수동 입력한 'True', 'true', 'TRUE', 1 등)을 안전하게 파싱
 */
function parseSoldOutValue_(val) {
  if (val === true || val === 1) return true;
  if (val === false || val === 0) return false;
  const str = String(val || '').trim().toLowerCase();
  return str === 'true' || str === '1' || str === 'yes' || str === 'y' || str === '품절';
}

function runCrawlForWatch_(watchId, userName, discordWebhook, telegramBotToken, telegramChatId, parsedRule, sites, isInitialScan) {
  isInitialScan = Boolean(isInitialScan);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const snapSheet = ss.getSheetByName(SHEET_SNAPSHOTS);
  const snapData = snapSheet.getDataRange().getValues();

  // 기존 스냅샷 로드 시 '../'가 포함되었던 구버전 URL 키와 정규화된 URL 키를 모두 매핑하여
  // 중복 행 생성이나 오탐 알림 없이 기존 행을 제자리에서 갱신하도록 처리
  const snapMap = {};
  for (let r = 1; r < snapData.length; r++) {
    const rawKey = String(snapData[r][0] || '');
    const rowWatchId = String(snapData[r][1] || '');
    const rowSiteName = String(snapData[r][2] || '');
    const rawProdUrl = String(snapData[r][4] || '');
    const normProdUrl = resolveProductUrl_(rawProdUrl, '');
    const normKey = (rowWatchId && rowSiteName && normProdUrl)
      ? (rowWatchId + '|' + rowSiteName + '|' + normProdUrl)
      : rawKey;

    const entry = {
      rowNumber: r + 1,
      rawKey: rawKey,
      rawProdUrl: rawProdUrl,
      isSoldOut: parseSoldOutValue_(snapData[r][5])
    };
    if (rawKey) snapMap[rawKey] = entry;
    if (normKey) snapMap[normKey] = entry;
  }

  const matchedResults = [];
  const now = new Date().toISOString();

  sites.forEach(site => {
    try {
      const res = fetchHtmlWithEncoding_(site.siteUrl);
      if (res.statusCode < 200 || res.statusCode >= 400) return;

      const products = extractProductsFromHtml_(res.html, site.siteUrl);
      products.forEach(prod => {
        if (!matchesKeywordRule(prod.title, parsedRule)) return;

        const snapKey = watchId + '|' + site.siteName + '|' + prod.url;
        const prev = snapMap[snapKey];

        // 1단계 목록 스캔에서 품절이 아니더라도 2단계 상세 페이지 교차 검증 수행
        let finalSoldOut = prod.isSoldOut;
        if (!finalSoldOut) {
          const detailSoldOut = checkDetailPageSoldOut_(prod.url);
          if (detailSoldOut === true) {
            finalSoldOut = true;
          } else if (detailSoldOut === null && prev) {
            // 상세 페이지 일시적 통신 실패 시 기존 스냅샷 상태(또는 수동 설정한 True)를 덮어쓰지 않고 보존
            finalSoldOut = prev.isSoldOut;
          }
        }

        if (!prev) {
          snapSheet.appendRow([snapKey, watchId, site.siteName, prod.title, prod.url, finalSoldOut, now]);
          snapMap[snapKey] = {
            rowNumber: snapSheet.getLastRow(),
            rawKey: snapKey,
            rawProdUrl: prod.url,
            isSoldOut: finalSoldOut
          };
          if (!finalSoldOut) {
            // 최초 등록 스캔(isInitialScan=true) 시에는 알림을 보내지 않고 기준선으로만 등록!
            if (!isInitialScan) {
              sendWebhookNotification_(
                { discordWebhook, telegramBotToken, telegramChatId },
                '신상품/구매가능 상품이 감지되었습니다!',
                prod,
                site
              );
              matchedResults.push({ type: 'NEW', site: site.siteName, title: prod.title, url: prod.url });
            } else {
              matchedResults.push({ type: 'BASELINE', site: site.siteName, title: prod.title, url: prod.url });
            }
          }
        } else {
          // 기존 스냅샷이 품절(true)이었다가 이번 스캔에서 구매가능(false)으로 변경된 경우 -> 재입고 알림 발송
          if (prev.isSoldOut && !finalSoldOut) {
            sendWebhookNotification_(
              { discordWebhook, telegramBotToken, telegramChatId },
              '품절 상품의 재고가 들어왔습니다!',
              prod,
              site
            );
            matchedResults.push({ type: 'RESTOCK', site: site.siteName, title: prod.title, url: prod.url });
          }

          // 구버전 '../' URL이 저장되어 있던 행이면 정규화된 snapshotKey와 productUrl도 함께 정리
          if (prev.rawKey !== snapKey) {
            snapSheet.getRange(prev.rowNumber, 1).setValue(snapKey);
            prev.rawKey = snapKey;
          }
          if (prev.rawProdUrl !== prod.url) {
            snapSheet.getRange(prev.rowNumber, 5).setValue(prod.url);
            prev.rawProdUrl = prod.url;
          }
          snapSheet.getRange(prev.rowNumber, 6).setValue(finalSoldOut);
          snapSheet.getRange(prev.rowNumber, 7).setValue(now);
          prev.isSoldOut = finalSoldOut;
        }
      });
    } catch (e) {
      Logger.log('사이트 크롤링 오류 (' + site.siteName + '): ' + e.message);
    }
  });

  return matchedResults;
}

function runScheduledCrawl() {
  initSheets_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  const watchSheet = ss.getSheetByName(SHEET_WATCHES);

  const users = userSheet.getDataRange().getValues();
  const userMap = {};
  for (let i = 1; i < users.length; i++) {
    userMap[users[i][0]] = {
      userName: users[i][1],
      discordWebhook: users[i][2],
      telegramBotToken: users[i][3],
      telegramChatId: users[i][4]
    };
  }

  const watches = watchSheet.getDataRange().getValues();
  for (let i = 1; i < watches.length; i++) {
    const watchId = watches[i][0];
    const userId = watches[i][1];
    const user = userMap[userId];
    if (!user) continue;

    try {
      const parsedRule = JSON.parse(watches[i][5]);
      const sites = JSON.parse(watches[i][6]);
      runCrawlForWatch_(
        watchId,
        user.userName,
        user.discordWebhook,
        user.telegramBotToken,
        user.telegramChatId,
        parsedRule,
        sites
      );
      watchSheet.getRange(i + 1, 9).setValue(new Date().toISOString());
    } catch (e) {
      Logger.log('Watch 실행 실패 (' + watchId + '): ' + e.message);
    }
  }
}

/**
 * ============================================================================
 * [웹 앱 프론트엔드 UI 템플릿]
 * - GAS 자체 웹앱 환경(google.script.run)과 GitHub Pages(github.io) 정적 호스팅 환경(fetch)을
 *   모두 자동 감지하여 동작하도록 작성되어 있습니다.
 * ============================================================================
 */
function getHtmlTemplate_() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>상품 재입고 & 신상품 크롤링 모니터</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --primary: #2563eb;
      --danger: #dc2626;
      --success: #16a34a;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #64748b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Noto Sans KR", sans-serif;
      background: var(--bg); color: var(--text);
    }
    .container { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 6px; }
    .subtitle { color: var(--muted); font-size: 0.92rem; margin-bottom: 12px; line-height: 1.5; }
    .tip-banner {
      background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a;
      border-radius: 10px; padding: 12px 14px; font-size: 0.86rem; line-height: 1.55;
      margin-bottom: 18px;
    }
    .tip-banner strong { color: #1d4ed8; }
    .card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 20px; margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .card h2 { font-size: 1.05rem; margin: 0 0 14px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .helper-desc { font-size: 0.83rem; color: var(--muted); margin-bottom: 12px; line-height: 1.45; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; color: #334155; }
    input[type="text"], input[type="url"] {
      width: 100%; padding: 10px 12px; border: 1px solid var(--border);
      border-radius: 8px; font-size: 0.92rem; margin-bottom: 12px;
    }
    .row { display: flex; gap: 8px; align-items: flex-start; }
    .row input { flex: 1; margin-bottom: 0; }
    button {
      padding: 10px 16px; border-radius: 8px; border: none; font-weight: 600;
      cursor: pointer; font-size: 0.9rem; background: var(--primary); color: #fff;
      white-space: nowrap;
    }
    button.secondary { background: #475569; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .status-msg { font-size: 0.85rem; margin-top: 8px; font-weight: 600; }
    .status-error { color: var(--danger); }
    .status-ok { color: var(--success); }
    .tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .tag {
      background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;
      padding: 4px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 500;
    }
    .site-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 12px; background: #f1f5f9; border-radius: 8px; margin-top: 8px; font-size: 0.88rem;
    }
    .site-item button { background: var(--danger); padding: 4px 10px; font-size: 0.78rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎸 멀티 쇼핑몰 신상품 & 재입고 알리미</h1>
    <div class="subtitle">동일 상품을 여러 웹사이트(뮤직포스, 버즈비, 프리버드 등)에서 동시 감시하고 웹훅으로 즉시 알림을 받습니다.</div>

    <div class="tip-banner">
      💡 <strong>권장 등록 팁:</strong> 실제 감시할 쇼핑몰에 등록하실 때는 각 쇼핑몰의 전체 메인 주소(홈페이지 루트)보다
      <strong>브랜드 카테고리 페이지</strong>나 <strong>특정 모델(예: <code>jaguar</code>) 검색 결과 페이지 URL</strong>을 넣으시면 훨씬 빠르고 정확하게 신상품과 재입고를 감지할 수 있습니다.
    </div>

    <!-- 1. 유저 정보 및 디스코드/텔레그램 웹훅 등록 -->
    <div class="card">
      <h2>1. 유저 정보 & 디스코드 / 텔레그램 웹훅 설정</h2>
      <label>유저 이름 (별칭)</label>
      <input type="text" id="userName" placeholder="예: 홍길동 (guitar_hunter)" />

      <label>디스코드 웹훅 URL (선택)</label>
      <input type="url" id="discordWebhook" placeholder="https://discord.com/api/webhooks/..." />

      <div class="row" style="margin-bottom: 12px;">
        <div style="flex:1;">
          <label>텔레그램 봇 토큰 (선택)</label>
          <input type="text" id="telegramBotToken" placeholder="123456789:ABCdef..." />
        </div>
        <div style="flex:1;">
          <label>텔레그램 Chat ID (선택)</label>
          <input type="text" id="telegramChatId" placeholder="예: 987654321" />
        </div>
      </div>
      <button type="button" class="secondary" onclick="handleTestWebhook()">🔔 웹훅 테스트 발송</button>
      <div id="webhookStatus" class="status-msg"></div>
    </div>

    <!-- 2. 상품 키워드 등록 (한글/영문 파싱 및 경우의 수 자동 생성) -->
    <div class="card">
      <h2>2. 상품 키워드 등록 (한/영 및 파생 키워드 자동 확장)</h2>
      <div class="helper-desc">
        💡 <strong>다중 키워드 등록 팁:</strong> 세미콜론(<code>;</code>) 또는 엔터로 구분하면 동일한 사이트 묶음에 대해 여러 상품을 한 번에 감시할 수 있습니다. (예: <code>fender jaguar ; fender jazzmaster</code>)
      </div>
      <label>영문 키워드 입력</label>
      <input type="text" id="keywordsEn" placeholder="예: fender jaguar ; fender jazzmaster" oninput="updateKeywordPreview()" />

      <label>한글 키워드 입력</label>
      <input type="text" id="keywordsKo" placeholder="예: 펜더 재규어 ; 펜더 재즈마스터" oninput="updateKeywordPreview()" />

      <div style="font-size:0.83rem; color:var(--muted);">자동 생성된 검색 파생 키워드 (모두 등록 및 조합 검증):</div>
      <div id="keywordPreview" class="tag-list"></div>
    </div>

    <!-- 3 & 4. 감시할 웹사이트 등록 (즉시 크롤링 가능 여부 테스트) -->
    <div class="card">
      <h2>3. 모니터링 대상 웹사이트 등록 (동일 상품 다중 사이트 지원)</h2>
      <div class="helper-desc">
        ※ 쇼핑몰 메인 주소 대신 <strong>브랜드별 카테고리 목록 URL</strong> 또는 <strong>검색 결과 페이지 URL</strong>을 입력해 주세요. [등록] 클릭 시 즉시 크롤링 가능 여부를 테스트합니다.
      </div>
      <div class="row">
        <input type="text" id="siteNameInput" placeholder="사이트 별칭 (예: musicforce)" style="max-width: 190px;" />
        <input type="url" id="siteUrlInput" placeholder="검색/카테고리 페이지 URL (https://...)" />
        <button type="button" id="verifyBtn" onclick="handleAddWebsite()">등록</button>
      </div>
      <div id="siteVerifyMessage" class="status-msg"></div>
      <div id="registeredSitesList"></div>
    </div>

    <button type="button" style="width:100%; padding:14px; font-size:1rem;" onclick="handleSubmitAll()">
      🚀 모니터링 작업 최종 등록 및 첫 스캔 시작
    </button>
    <div id="finalStatus" class="status-msg"></div>
  </div>

  <script>
    /**
     * [GitHub Pages (github.io) 배포 시 설정]
     * 이 HTML을 index.html 로 저장해 github.io 에 배포할 경우,
     * 아래 GAS_WEB_APP_URL 변수에 Google Apps Script 배포 URL(https://script.google.com/macros/s/.../exec)을 넣으면
     * 자동으로 fetch(POST) 모드로 전환되어 동작합니다.
     */
    const GAS_WEB_APP_URL = '';
    const verifiedSites = [];

    function callBackend(action, params, onSuccess, onError) {
      if (typeof google !== 'undefined' && google.script && google.script.run) {
        const runner = google.script.run
          .withSuccessHandler(onSuccess)
          .withFailureHandler(onError || (err => console.error(err)));

        if (action === 'previewKeywordExpansion') {
          runner.previewKeywordExpansion(params.rawKeywordsEn, params.rawKeywordsKo);
        } else if (action === 'verifyWebsiteCrawlable') {
          runner.verifyWebsiteCrawlable(params.siteName, params.siteUrl);
        } else if (action === 'testWebhookConnection') {
          runner.testWebhookConnection(params.discordWebhook, params.telegramBotToken, params.telegramChatId);
        } else if (action === 'saveUserAndWatch') {
          runner.saveUserAndWatch(params.payload);
        }
      } else {
        if (!GAS_WEB_APP_URL) {
          if (onError) onError(new Error('GAS_WEB_APP_URL 상수에 Google Apps Script 웹앱 배포 URL을 설정해 주세요.'));
          return;
        }
        // CORS Preflight 방지를 위해 text/plain 으로 전송
        fetch(GAS_WEB_APP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ action: action }, params))
        })
          .then(r => r.json())
          .then(onSuccess)
          .catch(onError || (err => console.error(err)));
      }
    }

    function updateKeywordPreview() {
      const en = document.getElementById('keywordsEn').value;
      const ko = document.getElementById('keywordsKo').value;
      callBackend(
        'previewKeywordExpansion',
        { rawKeywordsEn: en, rawKeywordsKo: ko },
        res => {
          const container = document.getElementById('keywordPreview');
          container.innerHTML = '';
          (res.allExpandedKeywords || []).forEach(kw => {
            const span = document.createElement('span');
            span.className = 'tag';
            span.textContent = kw;
            container.appendChild(span);
          });
        }
      );
    }

    function handleAddWebsite() {
      const siteName = document.getElementById('siteNameInput').value.trim();
      const siteUrl = document.getElementById('siteUrlInput').value.trim();
      const msgEl = document.getElementById('siteVerifyMessage');
      const btn = document.getElementById('verifyBtn');

      if (!siteUrl) {
        msgEl.className = 'status-msg status-error';
        msgEl.textContent = '사이트 URL을 입력해 주세요.';
        return;
      }

      btn.disabled = true;
      msgEl.className = 'status-msg';
      msgEl.textContent = '⏳ 해당 웹사이트 크롤링 가능 여부를 테스트 중입니다...';

      callBackend(
        'verifyWebsiteCrawlable',
        { siteName: siteName, siteUrl: siteUrl },
        res => {
          btn.disabled = false;
          if (!res.ok) {
            msgEl.className = 'status-msg status-error';
            msgEl.textContent = '❌ ' + res.message + (res.detail ? ' (' + res.detail + ')' : '');
            alert(res.message + '\\n사유: ' + (res.detail || '크롤링 차단 또는 동적 렌더링 사이트'));
            return;
          }

          msgEl.className = 'status-msg status-ok';
          msgEl.textContent = '✅ ' + res.message;
          verifiedSites.push({ siteName: res.siteName, siteUrl: res.siteUrl });
          document.getElementById('siteNameInput').value = '';
          document.getElementById('siteUrlInput').value = '';
          renderSites();
        },
        err => {
          btn.disabled = false;
          msgEl.className = 'status-msg status-error';
          msgEl.textContent = '❌ 서비스 불가능한 사이트 입니다';
          alert('서비스 불가능한 사이트 입니다');
        }
      );
    }

    function renderSites() {
      const listEl = document.getElementById('registeredSitesList');
      listEl.innerHTML = '';
      verifiedSites.forEach((s, idx) => {
        const div = document.createElement('div');
        div.className = 'site-item';
        div.innerHTML = '<span><strong>[' + s.siteName + ']</strong> ' + s.siteUrl + '</span>' +
                        '<button type="button" onclick="removeSite(' + idx + ')">삭제</button>';
        listEl.appendChild(div);
      });
    }

    function removeSite(idx) {
      verifiedSites.splice(idx, 1);
      renderSites();
    }

    function handleTestWebhook() {
      const discord = document.getElementById('discordWebhook').value.trim();
      const tgToken = document.getElementById('telegramBotToken').value.trim();
      const tgChat = document.getElementById('telegramChatId').value.trim();
      const statusEl = document.getElementById('webhookStatus');

      statusEl.textContent = '⏳ 테스트 메시지 발송 중...';
      callBackend(
        'testWebhookConnection',
        { discordWebhook: discord, telegramBotToken: tgToken, telegramChatId: tgChat },
        res => {
          statusEl.className = 'status-msg status-ok';
          statusEl.textContent = '✅ ' + res.message;
        }
      );
    }

    function handleSubmitAll() {
      const userName = document.getElementById('userName').value.trim();
      const discordWebhook = document.getElementById('discordWebhook').value.trim();
      const telegramBotToken = document.getElementById('telegramBotToken').value.trim();
      const telegramChatId = document.getElementById('telegramChatId').value.trim();
      const rawKeywordsEn = document.getElementById('keywordsEn').value.trim();
      const rawKeywordsKo = document.getElementById('keywordsKo').value.trim();
      const finalEl = document.getElementById('finalStatus');

      if (!userName) {
        alert('유저 이름을 입력해 주세요.');
        return;
      }
      if (!rawKeywordsEn && !rawKeywordsKo) {
        alert('영문 또는 한글 상품 키워드를 입력해 주세요.');
        return;
      }
      if (verifiedSites.length === 0) {
        alert('최소 1개 이상의 크롤링 가능한 웹사이트를 등록해 주세요.');
        return;
      }

      finalEl.className = 'status-msg';
      finalEl.textContent = '⏳ 모니터링 규칙 저장 및 초기 스캔 중...';

      callBackend(
        'saveUserAndWatch',
        {
          payload: {
            userName,
            discordWebhook,
            telegramBotToken,
            telegramChatId,
            rawKeywordsEn,
            rawKeywordsKo,
            sites: verifiedSites
          }
        },
        res => {
          finalEl.className = 'status-msg status-ok';
          const baselineText = (res.baselineCount !== undefined ? res.baselineCount : (res.scanSummary ? res.scanSummary.length : 0));
          finalEl.innerHTML = '🎉 <strong>모니터링 등록 완료!</strong> 확장 키워드(' + (res.expandedKeywords || []).join(', ') + ')로 ' +
            verifiedSites.length + '개 사이트 감시를 시작했습니다.<br>' +
            '🛡️ <em>최초 등록 알림 방지 적용:</em> 기존 판매 중인 상품 ' + baselineText + '건을 기준선(Baseline)으로 등록했습니다. (기존 상품 알림은 가지 않으며, 이후 새로 올라온 신상품이나 재입고 상품부터 실시간 알림이 발송됩니다.)';
        }
      );
    }
  </script>
</body>
</html>`;
}
