/* AgriPricePH — 8 rice types (keys match database / API) */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.RiceTypes = [
  { key: 'impSpecial', label: 'Imported Special', color: '#6366F1', group: 'imported' },
  { key: 'impPremium', label: 'Imported Premium', color: '#8B5CF6', group: 'imported' },
  { key: 'impWellMilled', label: 'Imported Well-Milled', color: '#F59E0B', group: 'imported' },
  { key: 'impRegular', label: 'Imported Regular', color: '#F97316', group: 'imported' },
  { key: 'locSpecial', label: 'Local Special', color: '#EC4899', group: 'local' },
  { key: 'locPremium', label: 'Local Premium', color: '#14B8A6', group: 'local' },
  { key: 'locWellMilled', label: 'Local Well-Milled', color: '#4CAF6E', group: 'local' },
  { key: 'locRegular', label: 'Local Regular', color: '#3B82F6', group: 'local' },
];

AgriPricePH.RiceTypes.byKey = Object.fromEntries(
  AgriPricePH.RiceTypes.map((r) => [r.key, r])
);
