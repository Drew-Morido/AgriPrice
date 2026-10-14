# AgriPricePH — Demo script para sa DA validation (natural Taglish, lahat ng modules)

Live demo, admin side muna, tapos public side. Lahat ng module madadaanan: yung core features may detailed na
explanation, yung iba mini lang. Sinusundan nito yung order ng sidebar ng admin and ng menu ng public site.
Bukas ang system sa `http://127.0.0.1:5000/`. *(Italics)* = yung ki-click o ipapakita.

## Flow

**Quick Introduction** → landing page

**Methodology** → research design, Agile, data collection, forecasting model, evaluation

**Admin side** (sunod sa sidebar)
1. Login (password + PIN)
2. Dashboard Overview
3. Price Forecast
4. Price Alerts *(mini)*
5. Data Sources
6. Price History
7. Web Scraper
8. Taxes & Import Charges
9. Rice Brands *(mini)*
10. Market Drivers
11. Model Dashboard
12. Model Training
13. Reports & Export *(mini)*
14. User Management *(mini)*
15. System Settings *(mini)*
16. System Logs *(mini)*
17. Topbar: Search and Notifications *(mini)*
18. Account Profile *(mini)*
19. (Optional) datasets folder

**Public side** (sunod sa menu)
1. Landing page / Home
2. Price Forecast
3. Rice Catalog
4. Price History
5. Charts & Stats
6. Sign up and Log in (with Forgot Password) *(mini)*
7. Profile *(mini)*
8. Settings *(mini)*

**Closing** → landing page

---

## QUICK INTRODUCTION

*(Landing page)*

> Good morning po. So kami po yung team behind AgriPricePH. Basically, web-based system siya na nagmo-monitor and
> nagfo-forecast ng retail price ng rice dito sa Metro Manila, up to three days ahead. Yung main source po namin is yung
> price bulletins ng DA, and eight rice types yung tine-track namin: local and imported, tapos special, premium,
> well-milled, and regular milled.
>
> Yung goal po namin is magkaroon ng isang lugar kung saan makikita agad ng consumers and vendors yung current price and
> kung saan papunta yung presyo, and magkaroon ng tools yung staff para ma-manage yung data. And kayo po sa DA-AMAS ang
> mag-e-evaluate ng system using ISO 25010, in terms of functional suitability, performance efficiency, and reliability.
>
> Before po yung demo, quick lang po muna sa methodology namin.

---

## METHODOLOGY

*(Puwedeng nakabukas pa rin ang landing page, or isang slide kung meron)*

**Research design and development**
> Yung study po namin is developmental and quantitative. Developmental, kasi gumawa kami ng web-based system, and
> quantitative, kasi nag-train and nag-evaluate kami ng forecasting model gamit yung time-series data ng presyo.
>
> Para sa development, Agile po yung methodology na ginamit namin, with six phases: planning, analysis, design,
> implementation, testing, and deployment. Iterative po siya, by sprints, so paulit-ulit naming nire-review and
> inaayos yung system, lalo na yung scraper and yung model, based sa results ng testing.

**Data collection**
> Sa data collection po, automated siya, walang manual na survey. Kinukuha ng system yung data through PDF extraction,
> for the DA bulletins and DOE fuel prices, and through APIs, for PSA, World Bank, and exchange rate.
>
> Yung data po namin is from January 2015 up to today, and lahat po ng rice prices galing sa official sources. Yung 2015
> hanggang September 2018, monthly NCR retail price ng PSA. From October 2018 to 2022, yung daily price bulletins ng DA.
> 2023 hanggang February 2025, yung weekly prevailing prices ng DA, and from March 2025, yung DA Daily Price Index.
>
> Bukod sa presyo ng bigas, ginagamit din po namin as factors yung diesel price, dollar to peso rate, rice stocks, palay
> farmgate price, core inflation, world rice price, and season. Yung mga monthly data po, ginagamit lang namin starting
> sa date na talagang na-release na siya, para hindi kami gumagamit ng data na wala pa sa actual na araw na yun.

**Forecasting model**
> Sa forecasting po, per rice type yung model, so eight models. Tinitingnan niya yung last thirty days, tapos nagfo-forecast
> siya for the next three days. Yung forecast po is combination ng tatlong models: isang LSTM neural network with a
> mean-reversion correction, ARIMA, and Kalman filter. Every day, tinitingnan kung alin sa tatlo yung pinaka-accurate in
> the last thirty days, and mas malaki yung weight na binibigay sa kanya. Bawat forecast din po may price range, para
> hindi lang isang number yung nakikita.

**Evaluation**
> For evaluation po, dalawa yung part. Una, yung technical testing ng model. Hinati namin yung data into training, from
> 2015 to March 2025, validation, from April to October 2025, and testing, from October 2025 to October 2026, so isang
> buong taon na hindi nakita ng model during training. Ang sinukat po namin is yung error in pesos, kung ilang percent ng
> forecast ang pasok within one peso, and kinumpara namin siya sa simple na "same price as today" and sa ARIMA.
>
> Pangalawa, yung evaluation ng users: kayo po sa DA-AMAS, using ISO 25010, and yung households and local vendors, using
> a four-point Likert scale, for usability, effectiveness, and design.
>
> So yun po yung methodology. Proceed na po tayo sa system. May dalawang side po siya: yung admin dashboard para sa staff,
> and yung public website para sa consumers and vendors. Uunahin ko po yung admin side, and dadaanan ko po lahat ng
> modules.

---

## ADMIN SIDE

### 1. Login
*(Log in → admin username, password, tapos 6-digit PIN. Itago ang pag-type.)*

> Same login page lang po siya ng public, pero kapag admin account yung ginamit, may second step: after ng password,
> hihingi siya ng six-digit PIN. Kapag five times nagkamali, automatic na nala-lock yung account for fifteen minutes.

### 2. Dashboard Overview
*(Ituro isa-isa ang mga card)*

> So ito po yung dashboard. Dito po makikita agad yung Today's Rice Prices ng eight types, tapos yung Rice Price
> Predictions for the next days. Sa taas po may summary cards: yung Forecasts within one peso, yung average forecast
> error, yung current diesel price, and yung USD to PHP rate. And sa baba, may trend ng rice prices for the last ninety
> days.

### 3. Price Forecast
*(Next Day Prediction, Forecast vs Historical, Daily Forecast Table, tapos palitan ang rice type)*

> Next po yung Price Forecast. Ito po yung forecast ng lahat ng eight rice types. Dito po makikita yung Next Day
> Prediction, tapos yung chart ng forecast compared sa actual prices, and yung daily forecast table. Bawat forecast po may
> price range, so hindi lang isang number, may low and high kung saan most likely papasok yung actual price. Puwede rin
> pong palitan yung rice type dito.
>
> Isang note lang po: yung "tomorrow" sa forecast, ibig sabihin yung day after ng latest DA bulletin. Kasi kung wala pang
> bulletin today, hindi kami nag-a-assume ng presyo.

### 4. Price Alerts *(mini)*
*(Alert Rules, Add Alert Rule, Notification Log)*

> Ito po yung Price Alerts. Puwede mag-add ng alert rule, for example kapag tumaas or bumaba yung price ng isang rice type
> sa isang amount, or kapag biglang tumaas yung presyo. Lahat po ng na-trigger na alert, naka-record dito sa Notification
> Log.

### 5. Data Sources
*(Ituro ang "Connected sources 7/7")*

> Dito po sa Data Sources, makikita natin lahat ng pinagkukunan ng data. Seven sources po yung connected ngayon, and
> automatic po silang lahat.

*(Click isa-isa: DA → DOE → Exchange rates → Tariff → PSA → Core inflation → World rice price)*

> Una, yung DA, yung daily price bulletin para sa presyo ng eight rice types. Pangalawa, DOE, yung weekly fuel prices
> sa NCR, diesel yung ginagamit namin. Then yung exchange rate, dollar to peso. Yung Tariff Commission para sa import
> tariff ng bigas. Then yung PSA, para sa monthly rice stocks and palay farmgate price.
>
> And dalawa po dito yung bagong add namin. Yung core inflation galing sa PSA, and yung world rice price galing sa
> World Bank, yung export price ng Vietnam five percent, kasi Vietnam po yung main supplier natin ng imported rice.

*(Sa Core inflation, ituro ang "Latest values" at "Used by the model from")*

> Sa bawat source po, makikita yung latest value, kailan siya huling na-fetch, ilang records na yung naka-store, and kung
> up to date ba siya. Example dito sa core inflation, September 2026 yung latest, 4.7 percent. Tapos makikita niyo po
> dito, "Used by the model from October 15." Kasi po yung monthly data ng PSA, around mid next month pa siya
> nirerelease, so hindi namin siya ginagamit hangga't hindi pa talaga siya published.
>
> And kung gusto niyong kunin agad yung latest, may Fetch Now button per source.

### 6. Price History
*(Piliin ang "All" at 1Y/All, tapos palitan ang category sa Core Inflation at World Rice Price, tapos Export CSV)*

> Ito po yung Price History. Dito makikita yung complete na past prices from January 2015 up to today, may chart and
> data table, and puwede siyang i-filter by period and by category: local, imported, diesel, or currency.
>
> One thing po na inayos namin: lahat po ng rice prices dito from 2015 ay verified na sa official sources. Yung 2015
> hanggang September 2018, galing sa monthly NCR retail prices ng PSA. From October 2018 hanggang 2022, galing na sa daily
> price bulletins ng DA, around three thousand PDF bulletins yung dinownload and binasa namin. Then 2023 to early 2025, DA
> weekly prevailing prices, and from March 2025, yung DA Daily Price Index. So bawat araw po, alam namin kung saang
> publication galing yung presyo.
>
> Bago din po dito yung Core Inflation and World Rice Price. Since monthly sila, isang row per month yung table, and
> nakalagay din kung saan galing, PSA or World Bank. And lahat po ng ito puwedeng i-export.

*(Click ang Statistics tab sa taas)*

> May Statistics tab din po dito, para makita yung min, max, average, and distribution ng presyo per rice type.

### 7. Web Scraper
*(Ituro ang status cards, Scraper Schedule, Activity Log, at Held for review)*

> Next po yung Web Scraper. Ito yung automatic na kumukuha ng data. Sa taas po, makikita kung complete na yung DA rice
> bulletin for today, eight out of eight, yung DOE fuel, and yung exchange rates.
>
> Dito sa Scraper Schedule, nandito lahat ng sources, kasama yung dalawang bago, yung PSA core inflation and yung World
> Bank rice price, and kung kailan yung next run. Full sync po siya every twenty-four hours, and kapag wala pang DA
> bulletin for the day, nagre-retry siya every two hours from 7 AM to 9 PM. May Run Now button din po kung gusto
> i-scrape agad.
>
> Dito sa Activity Log, live po yung nakikita natin habang nagsa-scrape siya.
>
> And ito po yung importante, yung Held for Review. Kapag may nakuha yung scraper na presyo na mukhang mali, for example
> masyadong malayo sa usual na presyo, hindi niya agad ginagamit. Naka-hold muna siya dito, and yung admin yung
> mag-a-approve or mag-re-reject.

### 8. Taxes & Import Charges
*(Tariff schedule, Tariff rate history, Consumer-price preview)*

> Para naman po sa imported rice, ito yung Taxes and Import Charges. Dito naka-record yung import tariff and yung ibang
> charges. Automatic din po itong chine-check ng system sa Tariff Commission, pero kapag may bagong rate na na-detect,
> hindi niya agad ginagamit, kailangan muna i-approve ng admin. Nandito rin yung history ng tariff rates, and yung
> preview kung magkano yung magiging consumer price ng imported rice.

### 9. Rice Brands *(mini)*
*(Buksan ang isang brand, ituro ang Add Brand)*

> Ito po yung Rice Brands. Dito namin mina-manage yung mga brand ng bigas. Bawat brand naka-map sa isa sa eight rice
> types, may price, weight, and verification. Ito po yung lalabas mamaya sa Rice Catalog sa public side.

### 10. Market Drivers
*(Diesel vs. retail price trend, Driver strength, tapos piliin ang core inflation at world rice)*

> Ito naman po yung Market Drivers. Dito kinukumpara natin yung price ng rice sa mga factors na puwedeng maka-affect sa
> kanya. Makikita dito yung trend ng diesel versus rice, and yung driver strength, kung gaano kalakas yung relationship
> ng bawat factor sa rice price. Kasama na po dito yung core inflation and world rice price.

### 11. Model Dashboard
*(Actual vs forecast chart, at ang error chart)*

> Ito naman po yung Model Dashboard, dito namin chine-check kung gaano ka-accurate yung model. Yung forecast po namin is
> combination ng tatlong models: isang LSTM neural network, ARIMA, and Kalman filter, and every day, mas malaki yung
> weight ng model na mas accurate recently.
>
> Sa testing po, for one whole year: 96 percent ng forecasts for the next day ay within one peso ng actual DA price, and
> around 87 percent ay within fifty centavos. Yung average error po is around 22 to 33 centavos per kilo, depende sa rice
> type. Compared po sa simpleng "same price as today", 10 percent na mas mababa yung error, and mas accurate siya kaysa
> sa ARIMA sa lahat ng eight rice types.
>
> And bawat bagong forecast po ay nilo-log bago pa lumabas yung actual DA price, para tuloy-tuloy naming nache-check kung
> tama yung forecast.

### 12. Model Training
*(Subtitle na may inputs, Train/Validation/Test Split, Loss Curve, Hit Rate Trend, Training Runs, Training Log)*

> Dito po sa Model Training, puwede naming i-retrain yung model kapag may bagong data. Nakikita po dito yung inputs ng
> model: rice price, diesel, rice stocks, palay farmgate, dollar rate, core inflation, world rice price, and season.
>
> Nandito rin yung split ng data: yung training from 2015 to March 2025, validation from April to October 2025, and yung
> test from October 2025 to October 2026, so isang buong taon na hindi nakita ng model during training. Habang nagte-train,
> live po yung log and yung loss curve, and naka-save lahat ng past training runs.

### 13. Reports & Export *(mini)*
*(Mag-generate ng isang report, tapos Report History)*

> Ito po yung Reports. Puwede mag-generate ng reports, like price and forecast reports, and i-download as CSV, Excel, or
> i-print as PDF. Naka-save din po dito yung history ng mga na-generate na reports.

### 14. User Management *(mini)*
*(Roles, Add Admin, Add Public User)*

> Dito po sa User Management, nandito lahat ng accounts, public users and admins. May dalawang klase po ng admin: yung
> Super Admin, na kayang gawin lahat, and yung Admin, na pang day-to-day operations lang, so hindi siya puwede sa User
> Management, and view-only lang siya sa Settings and Training. Puwede rin mag-add ng admin dito, step by step siya:
> info, role, password, tapos PIN.

### 15. System Settings *(mini)*
*(Scraper & Sync, Enabled Sources, Retraining, Price Alerts, Session)*

> Ito po yung System Settings. Dito naka-set kung gaano kadalas mag-scrape, kung aling sources yung naka-on, yung
> settings ng model and retraining, alerts, and session.

### 16. System Logs *(mini)*

> And ito po yung System Logs, live na activity ng buong system.

### 17. Topbar: Search and Notifications *(mini)*
*(I-type sa search, halimbawa "alerts"; tapos click ang bell icon)*

> Sa taas po, may search bar, para mabilis mahanap at mapuntahan yung kahit anong module. And yung bell icon naman, dito
> lumalabas yung notifications, like yung mga na-trigger na price alerts.

### 18. Account Profile *(mini)*
*(Click ang profile/avatar sa taas, tapos Account Profile)*

> And dito po sa Account Profile, makikita ng admin yung sarili niyang info and recent activity, and puwede niyang i-edit
> yung profile and yung photo niya.

### 19. (Optional) Datasets folder
*(File Explorer: `datasets` → `1_factor_csv`, `2_backup_database`, `3_source_files\DA-AMAS\daily_bulletins_pdf`)*

> Additional lang po, ito yung datasets folder ng system. Organized po siya into three: yung final CSV per factor from
> 2015 up to today, yung backup database per factor plus full backups, and yung source files, kung saan naka-save lahat
> ng dinownload namin, like yung DA bulletins per year, yung PSA files, DOE, and World Bank. So kung kailangan i-verify,
> nandito po lahat ng original files.
>
> So yun po yung admin side. Punta naman tayo sa public side. Ito po yung makikita ng consumers and vendors.

---

## PUBLIC SIDE
*(Lipat sa public tab)*

### 1. Landing page / Home
*(I-scroll pababa nang dahan-dahan)*

> So ito po yung home page ng public site. Sa taas po, may quick intro ng system. Pag nag-scroll tayo pababa, nandito
> yung mga popular na rice names, yung features ng system, tapos may konting rice knowledge: yung anatomy ng rice, yung
> mga commercial brands, and Philippine rice trivia. Nandito rin po yung preview ng presyo ng eight rice types, yung scope
> ng data namin, and FAQ.

### 2. Price Forecast
*(Click Price Forecast sa menu)*

> Next po yung Price Forecast, ito po yung main page. Dito makikita agad yung current prices ng eight rice types, based
> sa latest DA bulletin, and makikita rin kung kailan yung date ng bulletin.

*(Ituro ang Tomorrow card, arrow, range, at 3-day chart)*

> Tapos dito, may forecast for the next three days. Makikita niyo po kung tataas, bababa, or steady lang yung price.
> Steady po kapag less than ten centavos lang yung galaw. And may price range din siya, so parang ito yung range kung saan
> most likely papasok yung actual price, around nine times out of ten.

### 3. Rice Catalog
*(Buksan ang isang imported brand)*

> Then ito po yung Rice Catalog, galing sa Rice Brands na pinakita ko kanina sa admin. Dito naka-list yung mga rice brands
> na nasa market, naka-group sa same eight rice types, and may estimated shelf price each. Kapag imported po yung rice,
> kasama na sa estimate yung import charges like yung tariff.

### 4. Price History
*(Palitan ang period: 1M, tapos 1Y)*

> Next po, yung Price History. Dito puwede nilang balikan yung past prices ng bawat rice type, same verified data na
> nakita natin sa admin, so makikita nila kung paano gumalaw yung presyo depende sa period na pipiliin nila.

### 5. Charts & Stats
> Ito naman po yung Charts and Stats. Parang summary siya, may charts and basic stats, like yung lowest, highest, and
> average price, para madali makita yung trend.

### 6. Sign up and Log in *(mini)*
*(Ituro ang "Continue with Google" at "Forgot password?")*

> Kahit wala pong account, makikita na yung main prices. Pero kung gagawa sila ng free account, puwede sa email or sa
> Google, ma-u-unlock na yung full price history and stats. Pagka-sign up, may welcome popup din for new users. And
> kapag nakalimutan yung password, may Forgot Password, magse-send siya ng code sa email.

### 7. Profile *(mini)*
> Dito po yung Profile ng user, nandito yung account info nila.

### 8. Settings *(mini)*
*(Palitan ang theme sa dark, tapos balik sa light)*

> And sa Settings, puwede nilang i-adjust yung display, like light or dark mode.

---

## CLOSING
*(Balik sa landing page)*

> So yun po yung AgriPricePH. In short po, kinukuha niya automatically yung official data, lalo na yung DA price
> bulletins, ginagawang madaling makita and ma-forecast yung presyo ng bigas for the next three days, and may tools yung
> staff para siguradong tama, verified, and updated yung data. Open po kami sa comments and suggestions niyo. Thank you
> po.

---

## KUNG MAGTANONG YUNG DA

**"Saan galing yung prices niyo?"**
> Sa DA price bulletins po for NCR. Yung daily bulletins from October 2018 hanggang 2022, yung weekly prevailing price
> for 2023 hanggang February 2025, and yung Daily Price Index starting March 2025. Yung 2015 hanggang September 2018
> naman po, galing sa monthly NCR retail price ng PSA, kasi yun po yung available na official data for those years.

**"Bakit 2023 to 2025 weekly lang?"**
> Yung daily bulletins po kasi during that period, low and high range lang yung nakalagay, walang isang prevailing price.
> So mas accurate po na gamitin yung weekly prevailing price ng DA kaysa hulaan yung presyo from the range.

**"Paano kung wala pang bulletin today?"**
> Nagre-retry po yung system every two hours, from 7 AM to 9 PM. Habang wala pa, yung latest official bulletin muna yung
> ginagamit, and doon naka-base yung forecast. Hindi po kami nag-a-assume ng presyo.

**"Bakit may inflation and world rice price?"**
> Part po sila ng economic factors na puwedeng maka-affect sa presyo ng bigas. Yung core inflation po yung ginamit namin,
> kasi hindi kasama doon yung food and energy, so hindi siya nag-o-overlap sa rice price and sa diesel. Yung world rice
> price naman po, Vietnam five percent, kasi doon galing yung karamihan ng imported rice natin.

**"May wholesale or fertilizer ba?"**
> Wala po. Retail price po yung focus namin, and yung fertilizer data ng PSA hanggang 2019 lang available, kaya hindi po
> namin sinama.

**"Gaano siya ka-accurate?"**
> Sa test po namin from October 2025 to October 2026, 96 percent ng forecasts for tomorrow ay within one peso. Yung
> average error po is around 22 to 33 centavos per kilo, depende sa rice type.

**"Hanggang ilang days yung forecast?"**
> Up to three days po. Beyond that, hindi na siya reliable para sa daily rice prices.

---

## Checklist bago mag-demo

- I-restart yung backend (`cd api && py -3.13 app.py`) and hintayin matapos yung isang scrape, para 7/7 yung Data
  Sources and may bagong lines sa Web Scraper log.
- Super Admin account yung gamitin, para lumabas lahat ng modules (User Management, Settings).
- Huwag ipakita yung password, PIN, or email ng kahit sinong user.
- Dalawang tab: isa naka-login na sa admin (uunahin), isa sa public site. Kung ipapakita yung datasets folder, buksan na
  rin sa File Explorer.
- Silipin muna yung Market Drivers. Kung hindi lumabas yung core inflation and world rice price doon, i-skip lang yung
  linyang yun (nasa Price History naman sila).
