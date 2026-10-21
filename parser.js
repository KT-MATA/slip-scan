// レシートの文字認識結果から項目を拾い出す。オフラインOCRは誤認識が多いので、
// 「見出し語の近くにある数字」を拾う方式にしている。
(function (global) {
  "use strict";

  const BRANDS = ["VISA", "Mastercard", "JCB", "AMEX", "Diners", "銀聯", "交通系IC", "楽天ペイ", "d払い", "PayPay", "au PAY", "QRその他", "その他"];
  const DEFAULT_CAR_LABELS = ["号車番号", "号車", "車番", "車号", "車両番号", "車両No", "号機"];

  // OCRが数字と取り違えやすい文字
  const DIGITISH = "0-9OoDQIl|!SsBZz";
  const toDigits = s => String(s || "")
    .replace(/[OoDQ]/g, "0").replace(/[Il|!]/g, "1").replace(/[Ss]/g, "5")
    .replace(/B/g, "8").replace(/[Zz]/g, "2").replace(/[^0-9]/g, "");

  const CJK = "　-ヿ㐀-鿿＀-￯";
  function normalize(text) {
    let t = String(text || "").normalize("NFKC");
    // 日本語OCRは文字の間に空白を入れがちなので、和文どうしの間の空白を詰める
    const re = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g");
    t = t.replace(re, "$1").replace(re, "$1");
    t = t.replace(/\\(?=\s*[\dZzSsOoIl])/g, "¥");  // 「\3,280」→「¥3,280」
    t = t.replace(/[ \t]+/g, " ");
    return t;
  }

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelsRe = labels => (labels && labels.length ? labels : DEFAULT_CAR_LABELS)
    .slice().sort((a, b) => b.length - a.length).map(esc).join("|");

  function findCar(lines, labels) {
    const ls = labelsRe(labels);
    const after = new RegExp(`(?:${ls})\\s*(?:No\\.?|NO\\.?|番号|号)?\\s*[:.;：,]?\\s*([${DIGITISH}]{1,6})(?![\\d\\/])`);
    const before = new RegExp(`([${DIGITISH}]{1,6})\\s*(?:号車|号機)`);
    const clean = d => d.replace(/^0+(?=\d)/, "");
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      let m = L.match(after);
      if (m) { const d = toDigits(m[1]); if (d) return clean(d); }
      m = L.match(before);
      if (m) { const d = toDigits(m[1]); if (d) return clean(d); }
      // 見出しだけの行で、番号が次の行に来ている場合
      if (new RegExp(`(?:${ls})\\s*[:.;：]?\\s*$`).test(L) && lines[i + 1]) {
        const n = lines[i + 1].match(new RegExp(`^\\s*([${DIGITISH}]{1,6})\\b`));
        if (n) { const d = toDigits(n[1]); if (d) return clean(d); }
      }
    }
    return "";
  }

  function amountIn(s) {
    if (!s) return 0;
    const re = new RegExp(`(¥)?\\s*([${DIGITISH}]{1,3}(?:[,.][${DIGITISH}]{3})+|[${DIGITISH}]{2,7})\\s*(円|-)?`, "g");
    let m, best = 0;
    while ((m = re.exec(s))) {
      const raw = m[2];
      if (!/\d/.test(raw)) continue;
      const v = parseInt(toDigits(raw), 10);
      if (v > 0 && v < 10000000) {
        // 「¥」「円」付き、または桁区切りのある数字を優先
        if (m[1] || m[3] || /[,.]/.test(raw)) return v;
        if (!best) best = v;
      }
    }
    return best;
  }

  const AMOUNT_LABELS = [/合計金額/, /支払金額/, /ご?利用金額/, /売上金額/, /金額/, /合計/, /運賃/];
  const NOT_AMOUNT = /(承認|伝票|端末|会員|番号|有効期限|No|号車|日時|日付|TEL|電話|残高|コード|通番|ID)/;
  function findAmount(lines) {
    for (const lab of AMOUNT_LABELS) {
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const m = L.match(lab);
        if (!m || /残高/.test(L)) continue;
        const rest = L.slice(m.index + m[0].length);
        let v = amountIn(rest);
        for (let k = 1; !v && k <= 2 && lines[i + k]; k++) {
          if (NOT_AMOUNT.test(lines[i + k])) break;
          v = amountIn(lines[i + k]);
        }
        if (v) return v;
      }
    }
    // 見出しが読めないときは「¥」「円」付き、または「2,500」のような桁区切りの数字の最大値
    let max = 0;
    for (const L of lines) {
      if (NOT_AMOUNT.test(L)) continue;
      const re = /¥\s*([\d,.]{2,11})|([\d,.]{2,11})\s*円|(?:^|[^\d,.\-\/])(\d{1,3}(?:,\d{3})+)(?![\d,.\-\/])/g;
      let m;
      while ((m = re.exec(L))) { const v = parseInt(toDigits(m[1] || m[2] || m[3]), 10); if (v > max && v < 10000000) max = v; }
    }
    return max;
  }

  function labeled(lines, labelRe, valRe) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(labelRe);
      if (!m) continue;
      const rest = lines[i].slice(m.index + m[0].length);
      let v = rest.match(valRe);
      if (!v && lines[i + 1]) v = lines[i + 1].match(valRe);
      if (v) return v[1];
    }
    return "";
  }

  function findDate(t) {
    let m = t.match(/(20\d{2})\s*[\/年.\-]\s*(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})/);
    if (!m) m = t.match(/\b(\d{2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\b/);
    if (!m) {
      const r = t.match(/R\s*(\d{1,2})\s*[\/年.\-]\s*(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})/); // 令和
      if (r) m = [r[0], String(2018 + Number(r[1])), r[2], r[3]];
    }
    if (!m) return "";
    let y = Number(m[1]); if (y < 100) y += 2000;
    const mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function findTime(t) {
    const m = t.match(/\b([01]?\d|2[0-3])\s*[:時]\s*([0-5]\d)/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  }

  // ICカードのAID（数字なので文字より読み取りやすい）でブランドを判定する
  const AIDS = [["A000000003", "VISA"], ["A000000004", "Mastercard"], ["A000000065", "JCB"],
    ["A000000025", "AMEX"], ["A000000152", "Diners"], ["A000000333", "銀聯"]];
  function findBrand(t) {
    const u = t.toUpperCase().replace(/\s+/g, "");
    const v = u.replace(/[1L]/g, "I").replace(/0/g, "O");
    if (/交通系|SUICA|PASMO|ICOCA|MANACA|TOICA|KITACA|SUGOCA|NIMOCA|はやかけん/.test(u)) return "交通系IC";
    if (/QR|コード支払|バーコード/.test(u) || /請求会社/.test(u)) {
      if (/楽天/.test(u)) return "楽天ペイ";
      if (/D払|D払い|ド払/.test(u) || /d払/.test(t)) return "d払い";
      if (/PAYPAY|ペイペイ/.test(u)) return "PayPay";
      if (/AUPAY/.test(u)) return "au PAY";
      return "QRその他";
    }
    if (/VISA|ビザ/.test(v)) return "VISA";
    if (/MASTER|マスター/.test(v)) return "Mastercard";
    if (/JCB/.test(u)) return "JCB";
    if (/AMERICANEXPRESS|AMEX|アメックス|アメリカンエキスプレス/.test(v)) return "AMEX";
    if (/DINERS|DINER|ダイナース/.test(v)) return "Diners";
    if (/UNIONPAY|銀聯|銀联|ギンレン/.test(v)) return "銀聯";
    const aid = u.match(/A[O0]{4,6}[0-9OIl]{4,}/);
    if (aid) {
      const d = "A" + toDigits(aid[0].slice(1));
      for (const [p, b] of AIDS) if (d.startsWith(p)) return b;
    }
    return "その他";
  }

  function findLast4(lines) {
    // 「会員番号」「カード番号」の行で、行末が4桁の数字ならそれを使う（先頭の数字は使わない）
    for (const L of lines) {
      if (!/会員番号|カード番号|カードNo|CARD/i.test(L) || /会社/.test(L)) continue;
      const m = L.replace(/\s+/g, "").match(/(\d{4})$/);
      if (m) return m[1];
    }
    return "";
  }

  const KEY_LABELS = [/号車/, /伝票番号/, /端末番号/, /承認番号/, /合計/, /金額/, /会員番号/, /カード/, /支払/, /利用日/, /売上/, /加盟店/, /ありがと/, /有効期限/];
  function labelScore(text) {
    const t = normalize(text);
    return KEY_LABELS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  }

  // 見出しの「号車番号」が太字で崩れて読めないときの予備：日付より上にある、行末の短い数字を号車とみなす
  function guessCar(lines, cars) {
    const known = new Set((cars || []).map(String));
    let end = lines.findIndex(L => /20\d{2}\s*[\/年.\-]\s*\d{1,2}/.test(L));
    if (end < 0) end = Math.min(lines.length, 6);
    for (let i = 0; i < end; i++) {
      const m = lines[i].match(/(?:^|[^\d\/:\-])(\d{2,4})\s*[)」]?\s*$/);
      if (m && !/TEL|電話|\d{3,}-/.test(lines[i]) && (!known.size || known.has(String(Number(m[1]))))) return String(Number(m[1]));
    }
    if (known.size) {   // 登録済みの号車番号がどこかに単独で書かれていれば使う
      for (let i = 0; i < end; i++) {
        for (const c of known) if (new RegExp(`(?:^|[^\\d])${c}(?:[^\\d]|$)`).test(lines[i])) return c;
      }
    }
    return "";
  }

  function parseLines(lines, opts) {
    const joined = lines.join("\n");
    let car = findCar(lines, opts && opts.carLabels), carGuessed = false;
    if (!car) { car = guessCar(lines, opts && opts.cars); carGuessed = !!car; }
    const amount = findAmount(lines);
    const type = /取消|取り消|VOID|キャンセル/.test(joined) ? "取消" : /返品|REFUND|返金/.test(joined) ? "返品" : "売上";
    const pay = /リボ/.test(joined) ? "リボ" : /ボーナス/.test(joined) ? "ボーナス" : /分割/.test(joined) ? "分割" : "一括";
    const approval = toDigits(labeled(lines, /承認(?:番号|No\.?|NO\.?)?/, new RegExp(`[:.;]?\\s*([${DIGITISH}]{4,8})`)));
    const slip = toDigits(labeled(lines, /伝票(?:番号|No\.?|NO\.?)?/, new RegExp(`[:.;]?\\s*([${DIGITISH}]{3,8})`)));
    const terminal = labeled(lines, /端末(?:番号|No\.?)/, /[:.;]?\s*([0-9A-Za-z\-]{4,20})/);
    const result = {
      car, amount, type, pay, approval, slip, terminal,
      brand: findBrand(joined), date: findDate(joined), time: findTime(joined), last4: findLast4(lines),
    };
    const missing = [];
    if (!car) missing.push("号車");
    if (!amount) missing.push("金額");
    if (result.brand === "その他") missing.push("ブランド");
    result.missing = missing;
    result.confidence = (!car || !amount || carGuessed) ? "low" : missing.length ? "medium" : "high";
    result.raw = joined;
    return result;
  }

  const TITLE = /票|カード|控|QR|IC|クレジット|支払/;
  // 1枚の写真に複数の伝票が写っているときは、「号車番号」の行ごとに区切って別々に読む
  function parseMany(text, opts) {
    const lines = normalize(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const carRe = new RegExp(`(?:${labelsRe(opts && opts.carLabels)})`);
    const starts = [];
    lines.forEach((L, i) => { if (carRe.test(L)) starts.push(i); });
    if (starts.length <= 1) return [parseLines(lines, opts)];
    const bounds = [0];
    for (let k = 1; k < starts.length; k++) {
      let b = starts[k];
      // 「号車番号」の直前にある見出し（売上票・交通系ICカードなど）は次の伝票に含める
      for (let n = 0; n < 3 && b - 1 > starts[k - 1] && TITLE.test(lines[b - 1]) && lines[b - 1].length < 30; n++) b--;
      bounds.push(b);
    }
    bounds.push(lines.length);
    const out = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      const r = parseLines(lines.slice(bounds[k], bounds[k + 1]), opts);
      if (r.car || r.amount) out.push(r);
    }
    return out.length ? out : [parseLines(lines, opts)];
  }

  // 伝票1枚に1回ずつ印字される言葉の出現回数から、写っている枚数を見積もる
  function countSlips(text) {
    const t = normalize(text);
    const n = re => (t.match(re) || []).length;
    return Math.max(n(/伝票番号/g), n(/端末番号/g), n(/ありがと/g), 1);
  }

  const parse = (text, opts) => parseLines(normalize(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean), opts);

  global.SlipParser = { parse, parseMany, labelScore, countSlips, normalize, BRANDS, DEFAULT_CAR_LABELS };
})(typeof window !== "undefined" ? window : globalThis);
