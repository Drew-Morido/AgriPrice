/* AgriPricePH — representative rice photos for Rice Catalog products that have no uploaded image.
 *
 * A product without its own photo used to show a generic bowl icon. It now shows a photo of the
 * kind of rice its record names — its package / variety text ("Thai Jasmine", "Jasponica Brown",
 * "Malagkit", "Black Rice" …), else its DA grade (regular-milled, well-milled, premium, special).
 * These are photos of the RICE, not of the brand's pack: brand pack shots from retailer sites are
 * copyrighted and a wrong or outdated pack would misrepresent a verified listing, so every use is
 * labelled "Representative photo" and credited. A real product photo uploaded from Admin → Rice
 * Brands always takes precedence.
 *
 * Photos are openly licensed (Wikimedia Commons: CC0 / CC BY / CC BY-SA; one Pexels photo) and
 * stored locally in public/images/rice-types/ — <kind>-card.jpg for the grid (≤720px) and
 * <kind>.jpg for the modal and full-size viewer (≤2000px) — so the catalog does not depend on a
 * third-party CDN. CC BY / BY-SA require the author, licence and source, shown in the modal.
 */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.RicePhotos = (function () {
  const DIR = 'images/rice-types/';

  const PHOTOS = {
    regular: {
      caption: 'Partly milled rice, with some bran left on the grains',
      author: 'ImageParty', license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      source: 'https://commons.wikimedia.org/wiki/File:White_rice_on_a_brown_table.jpg', site: 'Wikimedia Commons',
    },
    wellmilled: {
      caption: 'Well-milled white rice',
      author: '', license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/',
      source: 'https://www.pexels.com/photo/4110251/', site: 'Pexels',
    },
    premium: {
      caption: 'Polished white rice',
      author: 'Beatrice Murch', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0',
      source: 'https://commons.wikimedia.org/wiki/File:Handful_of_rice.jpg', site: 'Wikimedia Commons',
    },
    aromatic: {
      caption: 'Uncooked aromatic white rice',
      author: 'VinhNguyen.1257', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      source: 'https://commons.wikimedia.org/wiki/File:Uncooked_ST25_rice_on_bamboo_surface.jpg', site: 'Wikimedia Commons',
    },
    jasmine: {
      caption: 'Uncooked Thai jasmine rice',
      author: 'Takeaway', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0',
      source: 'https://commons.wikimedia.org/wiki/File:Thai_jasmine_rice_uncooked.jpg', site: 'Wikimedia Commons',
    },
    thai: {
      caption: 'Long-grain white rice',
      author: 'Sanjay Acharya', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      source: 'https://commons.wikimedia.org/wiki/File:WhiteRice.jpg', site: 'Wikimedia Commons',
    },
    japonica: {
      caption: 'Short-grain (japonica-type) white rice',
      author: 'Maumivi', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      source: 'https://commons.wikimedia.org/wiki/File:Korean_aromatic_rice.png', site: 'Wikimedia Commons',
    },
    brown: {
      caption: 'Long-grain brown rice',
      author: 'Billjones94', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      source: 'https://commons.wikimedia.org/wiki/File:Brown_rice_(whole_grain_rice)_photographed_in_West_Bengal,_India.jpg', site: 'Wikimedia Commons',
    },
    'brown-short': {
      caption: 'Medium-grain brown rice',
      author: 'Chouk Khmer', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      source: 'https://commons.wikimedia.org/wiki/File:Germinated_brown_rice_-_medium_grain.jpg', site: 'Wikimedia Commons',
    },
    red: {
      caption: 'Uncooked red rice',
      author: 'Véronique PAGNIER', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0',
      source: 'https://commons.wikimedia.org/wiki/File:Riz_rouge_de_Camargue.jpg', site: 'Wikimedia Commons',
    },
    black: {
      caption: 'Uncooked black rice',
      author: 'Sanjay Acharya', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      source: 'https://commons.wikimedia.org/wiki/File:Black_Rice.jpg', site: 'Wikimedia Commons',
    },
    glutinous: {
      caption: 'Uncooked glutinous rice (malagkit)',
      author: 'Takeaway', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      source: 'https://commons.wikimedia.org/wiki/File:2014_uncooked_Thai_glutinous_rice.jpg', site: 'Wikimedia Commons',
    },
  };

  // First match wins, so the specific kinds come before the general ones ("Jasponica Brown" is
  // brown short-grain, not white japonica). Matched against the product's package and recorded
  // variety only — brand names are marketing ("Coco Thai" is a local well-milled rice).
  const RULES = [
    [/\bblack\b/, 'black'],
    [/\bred\b/, 'red'],
    [/glutinous|malagkit/, 'glutinous'],
    [/(jasponica|miponica|japonica)[^,;]*brown|brown[^,;]*(jasponica|miponica|japonica)/, 'brown-short'],
    [/\bbrown\b/, 'brown'],
    [/jasponica|miponica|japonica/, 'japonica'],
    [/jasmine|hom mali/, 'jasmine'],
    [/dinorado|aromatic|fragrant/, 'aromatic'],
    [/\bthai\b/, 'thai'],
  ];
  // No variety word: the DA grade says how polished the rice is.
  const BY_GRADE = { Regular: 'regular', WellMilled: 'wellmilled', Premium: 'premium', Special: 'aromatic' };

  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** Which representative photo fits a product. `key` is its category (locSpecial, impPremium …). */
  function kindFor(b, key) {
    const text = norm([b.package, b.variety_names].filter(Boolean).join(' ; '));
    for (const [re, kind] of RULES) if (re.test(text)) return kind;
    const k = String(key || '');
    const grade = k.replace(/^(loc|imp)/, '');
    // Imported non-special rice in the catalog is Thai/Vietnamese long-grain white.
    if (k.startsWith('imp') && grade !== 'Special') return 'thai';
    return BY_GRADE[grade] || 'wellmilled';
  }

  /** { kind, card, full, caption, author, license, licenseUrl, source, site } */
  function forBrand(b, key) {
    const kind = kindFor(b, key);
    return { kind, card: `${DIR}${kind}-card.jpg`, full: `${DIR}${kind}.jpg`, ...PHOTOS[kind] };
  }

  return { forBrand, kindFor, PHOTOS };
})();
