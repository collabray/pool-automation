// English + Swahili. Missing Swahili keys fall back to English so the UI never shows a raw key.
const en = {
  lang: 'Language', pay_title: 'Pay for games', price_per_game: 'Price per game', how_many: 'How many games?', custom: 'Other', games: 'games', game: 'game',
  total: 'Total', phone: 'M-Pesa phone number', phone_hint: 'e.g. 0712 345 678', pay_btn: 'Pay with M-Pesa', paying: 'Sending request\u2026', phone_invalid: 'Enter a valid Safaricom number, e.g. 0712345678.',
  check_phone: 'Check your phone and enter your M-Pesa PIN', waiting_for: 'Waiting for payment', seconds_left: 'seconds left', success_title: 'Payment received. Balls released, enjoy!', receipt: 'M-Pesa receipt', games_left: 'Games remaining',
  st_cancelled: 'You cancelled the payment. No money was taken.', st_wrong_pin: 'Wrong M-Pesa PIN. No money was taken.', st_insufficient: 'Not enough M-Pesa balance. No money was taken.', st_timeout: 'The request timed out. If money was taken your games will still be added.',
  st_failed: 'The payment failed. No money was taken.', st_expired: 'We did not receive a confirmation. If money was taken, show your M-Pesa message to the attendant.', try_again: 'Try again',
  tbl_offline: 'This table is offline right now. Please ask the attendant. You have not been charged.', tbl_faulted: 'This table has a fault. Please ask the attendant. You have not been charged.', tbl_disabled: 'This table is not available.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.', unknown_table: 'This QR code is not valid. Please ask the attendant.', network_error: 'Connection problem. Please try again.', not_configured: 'Mobile payments are not set up yet. Please pay the attendant.',
  other_ways: 'Other ways to pay', voucher: 'Voucher code', redeem: 'Use voucher', voucher_ok: 'Voucher accepted. Balls released, enjoy!', paybill: 'Pay by M-Pesa Paybill', paybill_no: 'Paybill number', account_no: 'Account number', paybill_note: 'Games are added automatically within a minute of paying the exact amount.',
  min_games: 'Minimum', max_games: 'Maximum',
  // staff UI
  login: 'Sign in', username: 'Username', password: 'Password', pin: 'PIN', logout: 'Sign out', save: 'Save', cancel: 'Cancel', confirm: 'Confirm', loading: 'Loading\u2026', error: 'Something went wrong',
  dashboard: 'Dashboard', tables: 'Tables', payments: 'Payments', staff: 'Staff', reports: 'Reports', system: 'System', vouchers: 'Vouchers', shifts: 'Shifts', today: 'Today', yesterday: 'Yesterday', week: 'This week', month: 'This month',
  revenue: 'Money earned', games_sold: 'Games sold', games_played: 'Games played', open_table: 'Open table', online: 'Online', offline: 'Offline', faulted: 'Faulted', credits_pending: 'Games waiting',
  sell: 'Sell', my_day: 'My day', shift: 'Shift', open_shift: 'Open shift', close_shift: 'Close shift', cash_received: 'Cash received', confirm_cash: 'Confirm cash received', change: 'Change', receipt_no: 'Receipt',
};
const sw = {
  lang: 'Lugha', pay_title: 'Lipia michezo', price_per_game: 'Bei kwa mchezo', how_many: 'Michezo mingapi?', custom: 'Nyingine', games: 'michezo', game: 'mchezo', total: 'Jumla', phone: 'Namba ya simu ya M-Pesa', phone_hint: 'mf. 0712 345 678',
  pay_btn: 'Lipa kwa M-Pesa', paying: 'Inatuma ombi\u2026', phone_invalid: 'Weka namba sahihi ya Safaricom, mf. 0712345678.', check_phone: 'Angalia simu yako na uweke PIN yako ya M-Pesa', waiting_for: 'Tunasubiri malipo', seconds_left: 'sekunde zimebaki',
  success_title: 'Malipo yamepokelewa. Mipira imeachiliwa, furahia!', receipt: 'Risiti ya M-Pesa', games_left: 'Michezo iliyobaki', st_cancelled: 'Umesitisha malipo. Hakuna pesa iliyokatwa.', st_wrong_pin: 'PIN ya M-Pesa si sahihi. Hakuna pesa iliyokatwa.',
  st_insufficient: 'Salio la M-Pesa halitoshi. Hakuna pesa iliyokatwa.', st_timeout: 'Muda umeisha. Ikiwa pesa ilikatwa, michezo yako bado itaongezwa.', st_failed: 'Malipo yameshindwa. Hakuna pesa iliyokatwa.',
  st_expired: 'Hatukupokea uthibitisho. Ikiwa pesa ilikatwa, mwonyeshe mhudumu ujumbe wako wa M-Pesa.', try_again: 'Jaribu tena', tbl_offline: 'Meza hii haipatikani sasa. Muulize mhudumu. Hujakatwa pesa.', tbl_faulted: 'Meza hii ina hitilafu. Muulize mhudumu. Hujakatwa pesa.',
  tbl_disabled: 'Meza hii haipatikani.', rate_limited: 'Majaribio mengi sana. Subiri kidogo ujaribu tena.', unknown_table: 'Msimbo huu wa QR si sahihi. Muulize mhudumu.', network_error: 'Tatizo la mtandao. Jaribu tena.', not_configured: 'Malipo ya simu bado hayajawekwa. Lipa kwa mhudumu.',
  other_ways: 'Njia nyingine za kulipa', voucher: 'Msimbo wa vocha', redeem: 'Tumia vocha', voucher_ok: 'Vocha imekubaliwa. Mipira imeachiliwa, furahia!', paybill: 'Lipa kwa Paybill ya M-Pesa', paybill_no: 'Namba ya Paybill', account_no: 'Namba ya akaunti',
  paybill_note: 'Michezo huongezwa kiotomatiki ndani ya dakika moja baada ya kulipa kiasi kamili.', min_games: 'Kiwango cha chini', max_games: 'Kiwango cha juu',
  login: 'Ingia', username: 'Jina la mtumiaji', password: 'Nenosiri', pin: 'PIN', logout: 'Toka', save: 'Hifadhi', cancel: 'Ghairi', confirm: 'Thibitisha', loading: 'Inapakia\u2026', error: 'Hitilafu imetokea',
  dashboard: 'Dashibodi', tables: 'Meza', payments: 'Malipo', staff: 'Wafanyakazi', reports: 'Ripoti', system: 'Mfumo', vouchers: 'Vocha', shifts: 'Zamu', today: 'Leo', yesterday: 'Jana', week: 'Wiki hii', month: 'Mwezi huu',
  revenue: 'Pesa iliyopatikana', games_sold: 'Michezo iliyouzwa', games_played: 'Michezo iliyochezwa', open_table: 'Fungua meza', online: 'Mtandaoni', offline: 'Nje ya mtandao', faulted: 'Ina hitilafu', credits_pending: 'Michezo inayosubiri',
  sell: 'Uza', my_day: 'Siku yangu', shift: 'Zamu', open_shift: 'Fungua zamu', close_shift: 'Funga zamu', cash_received: 'Pesa taslimu', confirm_cash: 'Thibitisha pesa taslimu', change: 'Chenji', receipt_no: 'Risiti',
};
export const dictionaries = { en, sw };
let lang = 'en';
export function detectLang(nav = typeof navigator !== 'undefined' ? navigator : {}, store = typeof localStorage !== 'undefined' ? localStorage : null) {
  const saved = store && store.getItem && store.getItem('lang'); if (saved && dictionaries[saved]) return saved;
  return String(nav.language || '').toLowerCase().startsWith('sw') ? 'sw' : 'en';
}
export function setLang(l, store = typeof localStorage !== 'undefined' ? localStorage : null) { if (dictionaries[l]) { lang = l; if (store && store.setItem) store.setItem('lang', l); } return lang; }
export const getLang = () => lang;
export function t(key, vars = {}) {
  let s = dictionaries[lang][key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
