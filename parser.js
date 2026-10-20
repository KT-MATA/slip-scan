// レシートの文字認識結果から項目を拾い出す。オフラインOCRは誤認識が多いので、
// 「見出し語の近くにある数字」を拾う方式にしている。
(function (global) {
  "use strict";

  const BRANDS = ["VISA", "Mastercard", "JCB", "AMEX", "Diners", "銀聯", "その他"];
  const DEFAULT_CAR_LABELS = ["号車", "車番", "車号", "車両番号", "車両No", "号機"];

  // OCRが数字と取り違えやすい文字
  const DIGITISH = "0-9OoDQIl|!SsBZz";
  const toDigits = s => s
    .replace(/[OoDQ]/g, "0").replace(/[Il|!]/g, "1").replace(/[Ss]/g, "5")
    .replace(/B/g, "8").replace(/[Zz]/g, "2").replace(/[^0-9]/g, "");

  const CJK = "　-ヿ㐀-鿿＀-￯";
  function normalize(text) {
    let t = String(text || "").normalize("NFKC");
    // 日本語OCRは文字の間に空白を入れがちなので、和文どうしの間の空白を詰める
    const re = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g");
    t = t.replace(re, "$1").replace(re, "$1");
    t = t.replace(/\\(?=\s*\d)/g, "¥");           // 「\3,280」→「¥3,280」
    t = t.replace(/[ \t]+/g, " ");
    return t;
  }

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function findCar(lines, labels) {
    const ls = (labels && labels.length ? labels : DEFAULT_CAR_LABELS).map(esc).join("|");
    const after = new RegExp(`(?:${ls})\\s*(?:No\\.?|NO\\.?|番号)?\\s*[:.]?\\s*([${DIGITISH}]{1,6})`);
    const before = new RegExp(`([${DIGITISH}]{1,6})\\s*(?:号車|号機)`);
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      let m = L.match(after);
      if (m) { const d = toDigits(m[1]); if (d) return d.replace(/^0+(?=\d)/, ""); }
      m = L.match(before);
      if (m) { const d = toDigits(m[1]); if (d) return d.replace(/^0+(?=\d)/, ""); }
      // 見出しだけの行で、番号が次の行に来ている場合
      if (new RegExp(`(?:${ls})\\s*[:.]?\\s*$`).test(L) && lines[i + 1]) {
        const n = lines[i + 1].match(new RegExp(`^\\s*([${DIGITISH}]{1,6})\\b`));
        if (n) { const d = toDigits(n[1]); if (d) return d.replace(/^0+(?=\d)/, ""); }
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
      if (!m[1] && !m[3] && !/[,.]/.test(raw) && !/\d/.test(raw)) continue;
      const v = parseInt(toDigits(raw), 10);
      if (v > 0 && v < 10000000) {
        // 「¥」「円」付き、または桁区切りのある数字を優先
        if (m[1] || m[3] || /[,.]/.test(raw)) return v;
        if (!best) best = v;
      }
    }
    return best;
  }

  const AMOUNT_LABELS = [/ご?利用金額/, /お?支払(?:金額|額)/, /合計(?:金額)?/, /売上金額/, /運賃/, /金額/];
  const NOT_AMOUNT = /(承認|伝票|端末|会員|番号|有効期限|No|号車|日時|日付|TEL|電話)/;
  function findAmount(lines) {
    for (const lab of AMOUNT_LABELS) {
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const m = L.match(lab);
        if (!m) continue;
        const rest = L.slice(m.index + m[0].length);
        let v = amountIn(rest);
        if (!v && lines[i + 1] && !NOT_AMOUNT.test(lines[i + 1])) v = amountIn(lines[i + 1]);
        if (v) return v;
      }
    }
    // 見出しが読めないときは「¥」か「円」の付いた数字の最大値
    let max = 0;
    for (const L of lines) {
      if (NOT_AMOUNT.test(L)) continue;
      const re = /¥\s*([\d,.]{2,11})|([\d,.]{2,11})\s*円/g;
      let m;
      while ((m = re.exec(L))) { const v = parseInt(toDigits(m[1] || m[2]), 10); if (v > max && v < 10000000) max = v; }
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

  function findBrand(t) {
    const u = t.toUpperCase().replace(/\s+/g, "").replace(/[1L]/g, "I").replace(/0/g, "O");
    if (/VISA|ビザ/.test(u)) return "VISA";
    if (/MASTER|マスター/.test(u)) return "Mastercard";
    if (/JCB/.test(t.toUpperCase().replace(/\s+/g, ""))) return "JCB";
    if (/AMERICANEXPRESS|AMEX|アメックス|アメリカンエキスプレス/.test(u)) return "AMEX";
    if (/DINERS|DINER|ダイナース/.test(u)) return "Diners";
    if (/UNIONPAY|銀聯|銀联|ギンレン/.test(u)) return "銀聯";
    return "その他";
  }

  function findLast4(lines) {
    // 「会員番号」「カード番号」の行なら、伏せ字がどう読めても行末の4桁を使う
    for (const L of lines) {
      if (!/会員番号|カード番号|カードNo|CARD/i.test(L)) continue;
      const m = L.replace(/\s+/g, "").match(/(\d{4})(?!\d)[^\d]*$/);
      if (m) return m[1];
    }
    for (const L of lines) {
      const c = L.replace(/\s+/g, "");
      const m = c.match(/(?:[*xX#＊・●]{2,}[-]?){1,3}(\d{4})(?!\d)/) || c.match(/\d{4}-?[*xX#]{4}-?[*xX#]{2,4}-?(\d{3,4})(?!\d)/);
      if (m) return m[1].slice(-4);
    }
    return "";
  }

  function parse(text, opts) {
    const norm = normalize(text);
    const lines = norm.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const joined = lines.join("\n");
    const car = findCar(lines, opts && opts.carLabels);
    const amount = findAmount(lines);
    const type = /取消|取り消|取消し|VOID|キャンセル/.test(joined) ? "取消" : /返品|REFUND|返金/.test(joined) ? "返品" : "売上";
    const pay = /リボ/.test(joined) ? "リボ" : /ボーナス/.test(joined) ? "ボーナス" : /分割/.test(joined) ? "分割" : "一括";
    const approval = toDigits(labeled(lines, /承認(?:番号|No\.?|NO\.?)?/, new RegExp(`[:.]?\\s*([${DIGITISH}]{4,8})`)));
    const slip = toDigits(labeled(lines, /伝票(?:番号|No\.?|NO\.?)?/, new RegExp(`[:.]?\\s*([${DIGITISH}]{3,8})`)));
    const terminal = labeled(lines, /端末(?:番号|ID|No\.?)?/, /[:.]?\s*([0-9A-Za-z\-]{4,20})/);
    const result = {
      car, amount, type, pay, approval, slip, terminal,
      brand: findBrand(joined), date: findDate(joined), time: findTime(joined), last4: findLast4(lines),
    };
    const missing = [];
    if (!car) missing.push("号車");
    if (!amount) missing.push("金額");
    if (result.brand === "その他") missing.push("ブランド");
    result.missing = missing;
    result.confidence = (!car || !amount) ? "low" : missing.length ? "medium" : "high";
    result.raw = norm;
    return result;
  }

  global.SlipParser = { parse, normalize, BRANDS, DEFAULT_CAR_LABELS };
})(typeof window !== "undefined" ? window : globalThis);
