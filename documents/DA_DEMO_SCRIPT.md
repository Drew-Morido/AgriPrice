# AgriPricePH — Demo script (intro, methodology, admin, public) — natural Taglish

Live demo. Walang time limit, mga 8–10 minuto. *(Italics)* = ang ki-click o ipapakita habang nagsasalita.
Bukas ang system sa `http://127.0.0.1:5000/`. Admin muna, tapos public.

## Flow
1. Intro → landing page
2. Methodology → research design, data, forecasting model, evaluation
3. Admin: Login → Dashboard → Price Forecast → Price Alerts → Data Sources → Price History → Web Scraper → Taxes & Import
   Charges → Rice Brands → Market Drivers → Model Dashboard → Model Training → Reports → User Management → Settings → Logs
4. Public: Home → Price Forecast → Rice Catalog → Price History → Charts & Stats → Sign up / Log in → Profile / Settings
5. Closing

---

## 1. INTRO
*(Landing page)*

> Good morning po. Kami po ang team behind AgriPricePH, isang web-based system na nagmo-monitor at nagfo-forecast ng
> retail price ng rice dito sa Metro Manila, hanggang tatlong araw ahead. Eight rice types po ang sinusubaybayan namin:
> local at imported, tapos special, premium, well-milled, at regular milled. Ang main source po ng presyo ay ang price
> bulletins ng DA.
>
> May dalawang side po ang system: ang admin dashboard para sa staff na nagma-manage ng data, at ang public website para
> sa consumers at vendors. Bago po tayo mag-demo, quick lang po ang methodology namin.

## 2. METHODOLOGY
*(Nasa landing page pa rin)*

**Design at development**
> Developmental at quantitative po ang study namin. Developmental, kasi gumawa kami ng web-based system, at quantitative,
> kasi nag-train at nag-evaluate kami ng forecasting model gamit ang time-series data ng presyo. Agile po ang ginamit
> naming methodology, may anim na phase: planning, analysis, design, implementation, testing, at deployment, na ginawa
> by sprints.

**Data**
> Automated po ang data collection, walang manual survey. Binabasa ng system ang DA price bulletins at ang fuel prices
> ng DOE mula sa mga PDF, at kumukuha ng data sa API mula sa PSA at World Bank. Mula January 2015 po ang data. Ang 2015
> hanggang September 2018 ay buwanang retail price ng PSA, ang October 2018 hanggang 2022 ay daily bulletins ng DA, ang
> 2023 hanggang February 2025 ay weekly prevailing prices ng DA, at mula March 2025 ay ang DA Daily Price Index.
> Bukod sa presyo ng bigas, ginagamit din namin ang diesel price, dollar rate, rice stocks, farmgate price, core
> inflation, world rice price, at season. Ang mga monthly data ay ginagamit lang mula sa araw na na-publish na talaga ang
> mga ito.

**Forecasting model**
> Bawat rice type po ay may sariling model, kaya eight models lahat. Tinitingnan nito ang huling 30 araw at nagfo-forecast
> ng susunod na tatlong araw. Tatlong model po ang pinagsasama: isang LSTM neural network na may mean-reversion
> correction, ARIMA, at Kalman filter. Araw-araw, binibigyan ng mas malaking timbang ang model na pinakatumpak sa huling
> 30 forecast. May kasama ring price range ang bawat forecast.

**Evaluation**
> Hinati po ang data sa training, mula 2015 hanggang March 2025, validation, mula April hanggang October 2025, at
> testing, mula October 2025 hanggang October 2026, kaya isang buong taon na hindi nakita ng model. Sinukat namin ang
> error sa piso, kung ilang porsyento ng forecast ang pasok sa isang piso, at kinumpara namin sa "same price as today" at
> sa ARIMA. Para sa user evaluation, kayo po sa DA-AMAS ay gagamit ng ISO 25010, at ang households at vendors ay gagamit
> ng four-point Likert scale. Tara po, simulan na natin sa admin side.

---

## 3. ADMIN SIDE

**Login** *(admin username at password, tapos six-digit PIN; itago ang pag-type)*
> Pareho po ang login page ng public, pero kapag admin account, may pangalawang hakbang: PIN pagkatapos ng password. Kapag
> limang beses nagkamali, nala-lock ang account ng fifteen minutes.

**Dashboard Overview** *(ituro isa-isa ang mga card)*
> Ito po ang dashboard. Makikita agad ang Today's Retail Rice Prices ng eight types, ang Retail Rice Price Forecast, at sa
> taas ang forecasts within one peso, ang average forecast error, ang diesel price, at ang dollar rate. Sa baba, ang
> trend ng presyo sa nakaraang ninety days.

**Price Forecast** *(3-Day Price Forecast card, "Forecasting models today", Next Day Prediction, chart, table)*
> Dito po ang forecast ng lahat ng eight rice types, para sa susunod na tatlong araw. Sa itaas, ang 3-Day Price Forecast
> card: nandito ang mga kasalukuyang presyo, at ang **Forecasting models today**, na nagpapakita kung alin sa tatlong model
> ang may pinakamalaking timbang ngayong araw, halimbawa Kalman filter na 35 percent. Kapag magkakalapit ang tatlo,
> nakasulat na "about equal." May info icon din na nagpapaliwanag kung paano ito kinukuwenta. Sa baba, ang Next Day
> Prediction na may low at high range, ang chart ng forecast kumpara sa actual price, at ang daily forecast table.
> Puwede ring palitan ang rice type. Ang "tomorrow" po ay ang araw pagkatapos ng pinakahuling DA bulletin, kaya hindi kami
> nag-a-assume ng presyong wala pa.

**Price Alerts** *(mini; Alert Rules, Add Alert Rule, Notification Log)*
> Sa Price Alerts, puwedeng mag-set ng rule, halimbawa kapag tumaas o bumaba ang presyo ng isang rice type sa isang
> amount. Lahat ng na-trigger ay naka-record sa Notification Log.

**Data Sources** *(7/7, i-click isa-isa, Core inflation, Fetch Now)*
> Ito po ang pinagkukunan ng data. Pito ang konektado at automatic lahat: DA para sa presyo ng bigas, DOE para sa diesel,
> exchange rate, Tariff Commission para sa import tariff, PSA para sa rice stocks at farmgate, at dalawang bago, ang core
> inflation mula sa PSA at ang world rice price mula sa World Bank. Sa bawat source, makikita ang latest value, kailan
> huling na-fetch, at kung up to date. Halimbawa sa core inflation, nakasulat ang "Used by the model from October 15,"
> kasi ginagamit lang ang monthly data kapag na-publish na ito. May Fetch Now button din kung gusto itong kunin agad.

**Price History** *(All, period All, Core Inflation / World Rice Price, Statistics, Export CSV)*
> Ito po ang kumpletong price history mula January 2015, may chart at table, at puwedeng i-filter ayon sa period at
> category. Verified po ang mga presyo sa official sources: PSA para sa 2015 hanggang September 2018, DA daily bulletins
> hanggang 2022, DA weekly at Daily Price Index pagkatapos, kaya alam namin kung saang publication galing ang bawat araw.
> Nandito rin ang Core Inflation at World Rice Price, isang row bawat buwan. May Statistics tab, at puwedeng i-export.

**Web Scraper** *(status cards, Schedule, Activity Log, Held for review)*
> Ito po ang kumukuha ng data. Makikita ang schedule ng bawat source at ang live log. Every twenty-four hours ang full
> sync, at kapag wala pang DA bulletin, nagre-retry ito tuwing dalawang oras mula 7 AM hanggang 9 PM. Kapag may presyong
> mukhang mali, hindi agad ginagamit. Nasa Held for review ito, at ang admin ang mag-a-approve o mag-re-reject.

**Taxes & Import Charges** *(tariff schedule, rate history, consumer-price preview)*
> Para sa imported rice po ito: ang import tariff at ibang charges. Chine-check ito ng system sa Tariff Commission, pero
> ang bagong rate ay hindi ginagamit hangga't hindi ina-approve ng admin. May history ng rates at preview ng magiging
> consumer price.

**Rice Brands** *(mini)*
> Dito po mina-manage ang mga brand. Naka-map ang bawat brand sa isa sa eight rice types, may price at weight. Ito ang
> lalabas sa Rice Catalog ng public side.

**Market Drivers** *(diesel vs rice, Driver strength)*
> Kinukumpara rito ang presyo ng bigas sa mga factor na puwedeng makaapekto, gaya ng diesel, exchange rate, core inflation
> at world rice price, at kung gaano kalakas ang relasyon ng bawat isa.

**Model Dashboard** *(actual vs forecast, error chart)*
> Dito po sinusukat ang accuracy. Sa test year, 96 percent ng next-day forecasts ay pasok sa isang piso ng actual DA price,
> mga 87 percent ay pasok sa limampung sentimo, at ang average error ay mga 22 hanggang 34 sentimo kada kilo, depende sa
> rice type. Sampung porsyentong mas mababa ang error kaysa sa "same price as today," at mas tumpak ito sa ARIMA sa
> lahat ng eight types. Nilo-log din ang bawat bagong forecast bago lumabas ang actual price, para tuloy-tuloy ang pag-check.

**Model Training** *(inputs, split, Loss Curve, Training Runs, Log)*
> Dito po puwedeng i-retrain ang model kapag may bagong data. Makikita ang inputs at ang split ng data, at habang nagte-train,
> live ang log at ang loss curve. Naka-save ang lahat ng nakaraang training runs.

**Reports & Export** *(mini)*
> Puwedeng mag-generate ng reports at i-download bilang CSV, Excel, o i-print bilang PDF, at nakatago ang history ng reports.

**User Management** *(mini; roles, Add Admin)*
> Dito po ang accounts ng users at admins. May dalawang admin role: ang Super Admin na kayang gawin lahat, at ang Admin na
> pang day-to-day lang, kaya view-only siya sa Settings at Training at hindi siya puwede sa User Management.

**System Settings at System Logs** *(mini)*
> Sa Settings, nakatakda ang scraping schedule, ang mga source na naka-on, ang retraining, at ang session. Ang System Logs
> naman ay live na activity ng system.

**Search at Notifications** *(mini; i-type ang "alerts", tapos ang bell)*
> Sa taas po, may search bar para mapuntahan agad ang kahit anong module, at ang bell para sa mga notification.

*(Transition)*
> Iyan po ang admin side. Punta naman tayo sa public side, ang makikita ng consumers at vendors.

---

## 4. PUBLIC SIDE
*(Lipat sa public tab)*

**Home** *(i-scroll pababa)*
> Ito po ang home page: may intro ng system, ang retail prices ng eight rice types, ang mga feature, at kaunting rice
> knowledge, kasama ang FAQ.

**Price Forecast** *(Tomorrow card, arrow, range, 3-day chart)*
> Ito po ang main page. Nandito agad ang retail price ngayon ng eight rice types, base sa pinakahuling DA bulletin. Sa
> tabi, ang forecast para sa susunod na tatlong araw: kung tataas, bababa, o steady ang presyo, at ang range kung saan
> malamang papasok ang actual price. Steady po kapag wala pang sampung sentimo ang galaw, at ang range ay tumama mga siyam
> sa sampung beses.

**Rice Catalog** *(buksan ang isang imported brand)*
> Ito po ang Rice Catalog, galing sa Rice Brands na pinakita ko kanina. Naka-list ang mga brand sa market, naka-group sa
> parehong eight types, may estimated shelf price. Para sa imported, kasama na ang import charges gaya ng tariff.

**Price History** *(1M, tapos 1Y)*
> Dito po puwedeng balikan ng users ang nakaraang presyo ng bawat rice type sa napiling period, gamit ang parehong verified
> data na nakita natin sa admin.

**Charts & Stats**
> Summary po ito ng presyo sa charts at basic statistics: pinakamababa, pinakamataas, at average.

**Sign up / Log in** *(mini; "Continue with Google", "Forgot password?")*
> Kahit walang account, makikita ang main prices at forecast. Kapag nag-sign up, libre, gamit ang email o Google, mabubuksan
> ang buong price history at statistics. May Forgot Password din na magpapadala ng code sa email.

**Profile at Settings** *(mini; dark mode)*
> May profile ang bawat user, at sa Settings puwede nilang palitan ang display, gaya ng light o dark mode.

## 5. CLOSING
*(Balik sa landing page)*

> Iyan po ang AgriPricePH. Sa madaling sabi, awtomatiko nitong kinukuha ang official data, lalo na ang DA price bulletins,
> ginagawang madaling makita at ma-forecast ang retail price ng bigas hanggang tatlong araw, at may mga tool ang staff para
> siguradong tama at updated ang data. Bukas po kami sa inyong comments at suggestions. Maraming salamat po.

---

## Checklist bago mag-demo
- I-restart ang backend (`cd api && py -3.13 app.py`) at hintaying matapos ang isang scrape, para 7/7 ang Data Sources.
- Super Admin account para lumabas ang lahat ng module. Huwag ipakita ang password, PIN, o email ng users.
- Para sa public na Price History at Charts & Stats, mag-log in muna gamit ang public test account.
- Dalawang tab: admin (naka-login) at public.
- **Hindi pa ito sinasabi sa script, kasi wala pa sa system:** automatic na alerts, mga pangalan ng market, petsa sa tabi ng
  bawat presyo sa front page, at ang narrative sa ilalim ng graph. Idadagdag sa script kapag nagawa na.
