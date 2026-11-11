// One-time menu updates for databases that already have the menu saved.
// (A fresh database is filled from menu-data.js, so these are already in it.)
// Each update runs once. A rate is changed only if it is still the old rate listed here,
// so a price the owner has already edited by hand is never overwritten.
// Format: prices: [name, variant, old rate, new rate]   add: [category, category_hi, name, name_hi, variant, variant_hi, price]
module.exports = [
  {
    id: '2026-11-10-website-menu',
    note: 'Rates and items from thebaithakstories.netlify.app on 10 Nov 2026',
    prices: [
      ['Tandoor Roti', '', 20, 25],
      ['Butter Naan', '', 50, 45],
      ['Plain Naan', '', 30, 29],
      ['Garlic Naan', '', 35, 49],
      ['Cheese Naan', '', 50, 49],
      ['Paneer Kulcha', '', 40, 69],
      ['Plain Kulcha', '', 30, 29],
      ['Butter Kulcha', '', 35, 39],
      ['Lachha Paratha', '', 35, 39],
    ],
    add: [
      ['Veg Starters', 'वेज स्टार्टर', 'Crispy Corn', 'क्रिस्पी कॉर्न', '', '', 149],
      ['Veg Starters', 'वेज स्टार्टर', 'Chilli Potato', 'चिली पोटैटो', '', '', 189],
    ],
  },
];
