# Master Data — Community Format Reference

Generated from [`../../../Chandravanshi-Vivah-Documents/chandravanshi-community-format.md`](../../../Chandravanshi-Vivah-Documents/chandravanshi-community-format.md) **verbatim** (names only, no IDs).
This is an appendix to [`05-master-data.md`](05-master-data.md), not a build step. It records the exact name lists so the
seeder and the user-contributed-option flow have one authoritative source, and so transcription into a seed file
cannot drift by hand.

## Image-derived corrected caste names

The following is a corrected transcription of the attached reference image. These names are kept separate from the
existing provisional lists below: entries not present in the image have not been added or changed.

```text
Bind
Kewat
Dhiwar
Dhinwar
Dhimar
Godiya
Khairwar
Dhewar
Gond
Kaibarta
Gariya
Khagi
Guriya
Raj Gond
Kherwar
Keot
Kharwar
Manjhi
Nishad
Kahar
Ram
Tiyar
Tayar
Tiar
Ramani
Kamkar
Kharwara
Rajvanshi
Kshatrapati
Kashyap
Chandravanshi
Rawani
Karmkar
Bhojpuria
Jhinwar
Jheer
Jhir
Gond Gariya
Jhiwar
Jhimar
Turaha
Tureha
Mallah
Turah
Turaiha
Khirwar
Majhwar
Jaliya Kaibarta
Lodhi Rajput
Chandravanshi Tomar
Gaud
Kahar Gaud
Raikwar
Dhawan
Dheeru
Mehra
Mahaar
Chain
Chaia
Duley
Baidi
Jhalo-Malo
Berchain
Dewar
Malo
Gurri
Gonti
Keweta
Kotal
Kadma
Keuta
Keyt
Kewet
Keyot
Kola Kharwar
Meta
Namdas
Namasudra
Patni
Tior
Sardia
Khatri
Angikula Kshatriya
Pali
Besthar
Goondla
Beshta
Gangaputra
Gangavar
Jalari
Jalkshatriya
Koracha
Mathurashi
Nayvala
Pattapa
Thamiya Bhoi
Vadavaliya
Vaddi
Vanyekula Kshatriya
Bhoi
Chandravanshi Panik
Jhalo
Jhalo Malo
Malakar
```

**Rule from the source document: each context is kept separate, with no cross-merging.** The same name (for example
`Kashyap`) appears as a Kahar gotra, a Yadav gotra, a Rajput gotra, and a Kahar clan — these are four distinct
records, scoped by their parent context, never merged into one row.

## Canonical context object

Every master-data seed reference and every user-contributed option is expressed in this shape. Keys that do not
apply to a row are `null`, and are omitted from storage rather than blanked.

```js
community: {
    communityName: String | null,       // e.g. "Kahar Chandravanshi Kshatriya"
    subCommunityName: String | null,    // e.g. "Batham"
    surnameName: String | null,         // e.g. "Prasad"
    gotraName: String | null,           // e.g. "Bharadwaj"
    clanName: String | null,            // e.g. "Pindwal"  -> Rajput/Rajasthan clan, not a gotra
    aaspadName: String | null           // e.g. "अजनावद्या" -> Chandravanshi Khati lineage identifier
  }
```

## Category objects

| Category | Key | Collection | Parent scope | Notes |
|---|---|---|---|---|
| Community | `communityName` | `communities` | — | Platform-controlled; a user never creates one |
| Sub-community | `subCommunityName` | `sub_communities` | `communityId` | Regionally specific, not universal |
| Surname | `surnameName` | `surnames` | `communityId` | Region-specific candidates |
| Gotra | `gotraName` | `gotras` | `communityId`, optional `clanId` | Spelling variants must not fork the filtering list |
| Clan | `clanName` | `clans` | `communityId` | Rajasthan/Rajput clans; *not* gotras, kept separate |
| Aaspad | `aaspadName` | `aaspads` | `communityId` | Chandravanshi Khati lineage identifier; *not* gotra or surname |
| Spelling variant | `surnameName` (no community) | `surnames` (`isAlias: true`) | — | Chandravanshi spelling variants only |

## Inventory

| Category | Distinct entries |
|---|---|
| communityName | 408 |
| subCommunityName | 35 |
| surnameName | 54 |
| gotraName | 186 |
| clanName | 44 |
| aaspadName | 105 |
| **Total tuples** | **413** |

## Per-community inventory

### Kahar Chandravanshi Kshatriya

- **Sub-communities (23):** Batham, Bot, Dhimar, Dhuriya, Gharuk, Jaiswar, Kamkar, Khawar, Mehar / Mahar, Mallah, Raikwar, Rawani, Singhariya, Turaiya, Bhoi, Guria / Garauwa, Gond, Kaleni, Kamlethar, Hurka, Machhera, Mahara, Panbhara
- **Surnames (26):** Prasad, Ram, Singh, Verma, Reward, Sindhu, Sing, Das, Bhandare, Gangole, Kachare, Lachure, Ladke, Padre, Simbre, Aliman, Bando, Kanda, Kasyapa, Nag, Rawanpur, Suar, Dahariya, Damrauiya, Imiliya, Muderiya
- **Gotras (3):** Bharadwaj, Goutam, Kashyap
- **Clans (6):** Pindwal, Bamnawat, Katariya, Bilawat, Kashyap, Oatasaniya

### Yadav / Yaduvanshi

- **Sub-communities (12):** Yadav, Ahir, Gwala / Goala, Gop / Gope, Gavli, Golla, Konar / Idaiyan, Sadgop, Nandavanshi, Yaduvanshi, Goallavanshi, Krishanaut
- **Gotras (58):** Dagar, Babar, Afriya, Jadam, Tomar, Nirban, Thakaran, Koshaliya, Dahiya, Balwan, Khairta, Bichwalia, Makwana, Khimania, Ghanghas, Sogarwal, Agoriya, Ahela, Aveliya, Dagaria, Hoiya, Ilawa, Injhot, Udhadinya, Devar / Hasoli, Unaiya / Udiya, Kaniya, Barangiya, Karwal, Kasnal, Karotiya / Karir, Kanpuriya, Jreha, Kaswan / Kanya, Kalangiya, Kanwariya, Koheriya, Kosal, Kudhariya, Khariya / Alatiya, Baroud, Atri, Kashyap, Bharadwaj, Gautam, Vats, Garg, Kaushik, Shandilya, Rajoriya, Kamriya, Banafar, Chhalotare, Ghosi, Gadariya, Rao, Sadh, Gaur

### Rajput — Chandravanshi branch

- **Surnames (23):** Bachhal, Banaphar, Bhangalia, Bhatti, Bundela, Chandela, Chavada, Chudasama, Dhaiya, Dongre, Jadeja, Jadon, Jarral, Johiya, Katoch, Pahore, Pathania, Porus, Raidas / Ravidas, Raizada, Sarvaiya, Salar, Soam
- **Gotras (8):** Atri, Chandatreya (Chandrayan), Sheshdhar, Parashar, Goutam, Kashyap, Shunak, Gargya
- **Clans (28):** Tomar / Tanwar, Chandel, Chavda, Bais, Jhala, Katoch, Banaphar, Dor, Jethwa, Raksel, Pathania, Bhati, Jadeja, Jadaun, Chudasama, Samma, Karchul Haihay, Jarral, Pahore, Raizada, Soam / Som, Bhangalia, Gaharwar, Jaiswal, Bachgoti, Goud, Dod, Tomar

### Rajput

- **Gotras (9):** Kashyap, Gautam, Bharadwaj, Vashistha, Atri, Krishaniya, Chandratreya, Vatsa, Kaushal (Kashyap in some branches)

### _(no community — surname spelling variants only)_

- **Surnames (5):** Chandrwanshi, Chandrvanshi, Chandravanshi, Chandvanshi, Chandravansh

### Chandravanshi Khati

- **Gotras (105):** भंवरसिया (BHAVARSIYA), बोर्दिया (BORDIYA), गुन्घोडिया (GUCHODIYA), ननधारिया (NANDHARIYA), कण्ठगरिया (KANTHGARIYA), धनबरदाय (DHANABARADHAY), अज्वास्य (AJVASYA), ननदिया (NANDIYA), बाघोदारया (BAGHODARAYA), आंसावरिया (AANSAWARIYA), वजन्य देवाय (VAJANY DEVAY), चिक्लोद मान्य (CHIKLOD MANYA), मंगरोलिया (MANGROLIYA), किरतपुरिया (KIRATPURIYA), सलोनाराय (SAALONARAYA), विरोट्या (VIROTYA), छिबडिया (CHHIBADIYA), कुरंदनस्य (KURANDANASYA), संभत हेडिया (SAMBHAT HEDIYA), दलोंड्रिया (DALONDRIYA), इन्द्रिय (INDRIYA), विरोठिया (VIROTHIYA), वरसखिरिया (VARASKHIRIYA), इच्छावरिया (ICCHHAVARIYA), आकासोदिया (AAKASODIYA), ताजपुरिया (TAJPURIYA), संदोरन्य (SANDORANYA), उछोडिया (UCHODIYA), अवलण्या (ALVANYA), देवतरया (DEVTARAYA), भैसोदिया (BHAISODIYA), मण्डलवडिया (MANDLALAVADIYA), गोळ्या (GOLYA), जगोठिया (JAGOTHIYA), केलोडिया (KELODIYA), रुदड़िया (RUDADIYA), भादरिया (BHADARIYA), कनसिया (KANASIYA), पार्सवडिया (PARSAVADIYA), देवदालिया (DEVADALIYA), बींजलिया (BINJALIYA), सोठडिया (SOTHADIYA), सवासिया (SAVASIYA), सोनानिया (SONANIYA), सूतिया (SOOTHIYA), सिसोदिया (SISODIYA), शिवदासिया (SHIVDASIYA), सरोजिया (SAROJIYA), सगवलिया (SAGWALIYA), रिनोदिया (RINODIYA), रणवासिया (RANVASIYA), भडलावड़िया (BHADLAVADIYA), भठूरिया (BHATHURIYA), भैसरोदिया (BHAISROSIYA), भैसानिया (BHAISANIYA), भदौड़िया (BHADODIYA), भमोरिया (BHAMORIYA), बिनरोटिया (BINROTIYA), बीजलपुरिया (BIJALPURIYA), बिलावालिया (BILAVALIYA), बड़बोदिया (BADABODIYA), सिरसोडिया (SIRSODIYA), बबुलड़िया (BABULDIYA), बरनवाया (BARANVAYA), बरनासिया (BARNASIYA), पंचोरिया (PANCHORIYA), धनोरिया (DHANORIYA), देवथलिया (DEVTHALIYA), देथलिया (DETHALIYA), ठेंगलिया (THENGLIYA), तुमड़िया (TUMDIYA), तंडिया (TAMDIYA), तिलवड़िया (TILVADIYA), ठीकरोडिया (THIKARODIYA), डिंगरोडिया (DINGRODIYA), झलवाया (JHALWAYA), जवारिया (JAVARIYA), जमलिया (JAMLIYA), कामोठीया (KAMOTHIYA), जमगोड़िया (JAMGODIYA), जलोडिया (JALODIYA), चौरसिया (CHOURASIYA), चंदवासिया (CHANDVASIYA), ग्वालिया (GWALIYA), गुरवादिया (GURAVADIYA), गिड़गिड़ाया (GIDGIDAYA), गिरितिया (GIRITIYA), ख़िरबाड़ोदिया (KHIRABADODIYA), खचरोडिया (KHACHARODIYA), खरलिय (KHALIYA), खेवसिया (KHEVASIYA), खजुरिया (KHAJURIYA), केलिए (KELIYA), कुलखंडिया (KULKHANDIYA), कसंया (KASANYA), करंजिया (KARANJIYA), कसुन्दरिया (KASUNDARIYA), कल्मोदिया (KALMODIYA), करनावड़िया (KARNAVADIYA), उपलवड़िया (UPALAVADIYA), इटावदिया (ITAVDIYA), अकोलिया (AKOLIYA), अम्लवाडिया (AMALAVDIYA), अलेरिया (ALERIYA), अजनावडिया (AJNAVADIYA)
- **Aaspad (105):** अमलावद्या, अजनावद्या, अजवास्या, आलेरिया, असवारिया, आकोद्या, बरंडवा, बरनास्या, बाबड़ोद्या, बीजलपुरिया, विदरोढ्या, बीरोती, बिजारया, बीजाल्या बींजाल्या, बिजावरया, बिलोद्या, बामलोद्या, बिलाबल्या, भमोरया, भेंसोद्या, भेंसान्या, भवरास्या, भदेडिया भेदड़ना, चौरास्या, चितावद्या, चितावल्या, चन्दवास्या, छवड़ास्या, देहथल्या भारेजा, देवदल्या, डगग्या, डगरया, दिलोद्रया, डिगरोद्या, ठिकरोद्या, ढगा, ठुकरास्या, डकनावद्या, इटावद्या, गुनघोरिया, गुवाल्या, गुटावद्या, गुनघोड़ना, गंगावत्या, गागा, गागोत्या, गिरोढ्या, घुरावड्या, इछावारिया, जामगोद्या, जामल्या, जलोड्या, जागल्या, जावरिया, जवास्या, जागोढ्या, झललावा, जलावा, कनबाड़, कनास्या, करनावद्या, कारंजया, कलमोद्या, कैलोद्या, कनारिया, कामोद्या कामोडिया, कासरन्या कासरन्या, कुलखण्या, कामोदया, केल्या, कसोद्या, केसोदन्या, खीरबड़ोदिया, खिवाल्या, खजुरया, खिवास्या, खिरेल्या, खाचरोदाय, मठोड़या, मंडलावदया, महारावदया., मड़ोदया, नागढोंदया, नादोद्या, पीपल्या, पचौरया, पलसावद्या, रानावद्या, रोहड़ावद्या, रंडावद्या, रिनोज्या, रलियावना, रुदाहेड़या, रुघावड्या, सोठोल्या, सिरसोदिया, सिवदास्या, सिवास्या, सुमटेहडया, सुमढया, सालोन्या, अलोन्या, स्वाग्या, सनबान्या, सगबाल्या, तिलावदिया, ताजपुरिया, थेगल्या, उपलावदिया

## Clan → Gotra mappings

Only mappings the source states explicitly. A clan with no mapping here has no documented gotra in this source —
do not infer one.

| Community | Clan | Gotra |
|---|---|---|
| Rajput — Chandravanshi branch | Bhati | Atri |
| Rajput — Chandravanshi branch | Chandel | Chandatreya (Chandrayan) |
| Rajput — Chandravanshi branch | Chandel | Sheshdhar |
| Rajput — Chandravanshi branch | Chandel | Parashar |
| Rajput — Chandravanshi branch | Chandel | Goutam |
| Rajput — Chandravanshi branch | Chudasama | Atri |
| Rajput — Chandravanshi branch | Jadeja | Atri |
| Rajput — Chandravanshi branch | Katoch | Kashyap |
| Rajput — Chandravanshi branch | Katoch | Shunak |
| Rajput — Chandravanshi branch | Soam / Som | Atri |
| Rajput — Chandravanshi branch | Tomar | Gargya |

## Raw tuples

The full list, in source order, for direct use as seed input (`server/src/data/master/community.json`).

```json
[
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Batham",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Bot",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Dhimar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Dhuriya",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Gharuk",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Jaiswar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Kamkar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Khawar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Mehar / Mahar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Mallah",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Raikwar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Rawani",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Singhariya",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Turaiya",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Bhoi",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Guria / Garauwa",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Gond",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Kaleni",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Kamlethar",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Hurka",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Machhera",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Mahara",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": "Panbhara",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Prasad",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Ram",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Singh",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Verma",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Reward",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Sindhu",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Sing",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Das",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Bhandare",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Gangole",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Kachare",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Lachure",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Ladke",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Padre",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Simbre",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Aliman",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Bando",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Kanda",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Kasyapa",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Nag",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Rawanpur",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Suar",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Dahariya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Damrauiya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Imiliya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": "Muderiya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Bharadwaj",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Goutam",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kashyap",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Pindwal",
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Bamnawat",
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Katariya",
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Bilawat",
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Kashyap",
    "aaspadName": null
  },
  {
    "communityName": "Kahar Chandravanshi Kshatriya",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Oatasaniya",
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Yadav",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Ahir",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Gwala / Goala",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Gop / Gope",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Gavli",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Golla",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Konar / Idaiyan",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Sadgop",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Nandavanshi",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Yaduvanshi",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Goallavanshi",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": "Krishanaut",
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Dagar",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Babar",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Afriya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Jadam",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Tomar",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Nirban",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Thakaran",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Koshaliya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Dahiya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Balwan",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Khairta",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Bichwalia",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Makwana",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Khimania",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Ghanghas",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Sogarwal",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Agoriya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Ahela",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Aveliya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Dagaria",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Hoiya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Ilawa",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Injhot",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Udhadinya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Devar / Hasoli",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Unaiya / Udiya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kaniya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Barangiya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Karwal",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kasnal",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Karotiya / Karir",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kanpuriya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Jreha",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kaswan / Kanya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kalangiya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kanwariya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Koheriya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kosal",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kudhariya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Khariya / Alatiya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Baroud",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Atri",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kashyap",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Bharadwaj",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Gautam",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Vats",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Garg",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kaushik",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Shandilya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Rajoriya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kamriya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Banafar",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Chhalotare",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Ghosi",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Gadariya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Rao",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Sadh",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Yadav / Yaduvanshi",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Gaur",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Tomar / Tanwar",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Chandel",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Chavda",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Bais",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Jhala",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Katoch",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Banaphar",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Dor",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Jethwa",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Raksel",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Pathania",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Bhati",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Jadeja",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Jadaun",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Chudasama",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Samma",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Karchul Haihay",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Jarral",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Pahore",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Raizada",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Soam / Som",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Bhangalia",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Gaharwar",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Jaiswal",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Bachgoti",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Goud",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": "Dod",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Atri",
    "clanName": "Bhati",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Chandatreya (Chandrayan)",
    "clanName": "Chandel",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Sheshdhar",
    "clanName": "Chandel",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Parashar",
    "clanName": "Chandel",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Goutam",
    "clanName": "Chandel",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Atri",
    "clanName": "Chudasama",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Atri",
    "clanName": "Jadeja",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kashyap",
    "clanName": "Katoch",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Shunak",
    "clanName": "Katoch",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Atri",
    "clanName": "Soam / Som",
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Gargya",
    "clanName": "Tomar",
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kashyap",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Gautam",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Bharadwaj",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Vashistha",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Atri",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Krishaniya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Chandratreya",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Vatsa",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "Kaushal (Kashyap in some branches)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Bachhal",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Banaphar",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Bhangalia",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Bhatti",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Bundela",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Chandela",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Chavada",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Chudasama",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Dhaiya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Dongre",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Jadeja",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Jadon",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Jarral",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Johiya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Katoch",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Pahore",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Pathania",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Porus",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Raidas / Ravidas",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Raizada",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Sarvaiya",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Salar",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Rajput — Chandravanshi branch",
    "subCommunityName": null,
    "surnameName": "Soam",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": null,
    "subCommunityName": null,
    "surnameName": "Chandrwanshi",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": null,
    "subCommunityName": null,
    "surnameName": "Chandrvanshi",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": null,
    "subCommunityName": null,
    "surnameName": "Chandravanshi",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": null,
    "subCommunityName": null,
    "surnameName": "Chandvanshi",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": null,
    "subCommunityName": null,
    "surnameName": "Chandravansh",
    "gotraName": null,
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भंवरसिया (BHAVARSIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बोर्दिया (BORDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "गुन्घोडिया (GUCHODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ननधारिया (NANDHARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कण्ठगरिया (KANTHGARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "धनबरदाय (DHANABARADHAY)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "अज्वास्य (AJVASYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ननदिया (NANDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बाघोदारया (BAGHODARAYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "आंसावरिया (AANSAWARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "वजन्य देवाय (VAJANY DEVAY)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "चिक्लोद मान्य (CHIKLOD MANYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "मंगरोलिया (MANGROLIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "किरतपुरिया (KIRATPURIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सलोनाराय (SAALONARAYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "विरोट्या (VIROTYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "छिबडिया (CHHIBADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कुरंदनस्य (KURANDANASYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "संभत हेडिया (SAMBHAT HEDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "दलोंड्रिया (DALONDRIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "इन्द्रिय (INDRIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "विरोठिया (VIROTHIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "वरसखिरिया (VARASKHIRIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "इच्छावरिया (ICCHHAVARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "आकासोदिया (AAKASODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ताजपुरिया (TAJPURIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "संदोरन्य (SANDORANYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "उछोडिया (UCHODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "अवलण्या (ALVANYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "देवतरया (DEVTARAYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भैसोदिया (BHAISODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "मण्डलवडिया (MANDLALAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "गोळ्या (GOLYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "जगोठिया (JAGOTHIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "केलोडिया (KELODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "रुदड़िया (RUDADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भादरिया (BHADARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कनसिया (KANASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "पार्सवडिया (PARSAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "देवदालिया (DEVADALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बींजलिया (BINJALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सोठडिया (SOTHADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सवासिया (SAVASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सोनानिया (SONANIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सूतिया (SOOTHIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सिसोदिया (SISODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "शिवदासिया (SHIVDASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सरोजिया (SAROJIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सगवलिया (SAGWALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "रिनोदिया (RINODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "रणवासिया (RANVASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भडलावड़िया (BHADLAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भठूरिया (BHATHURIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भैसरोदिया (BHAISROSIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भैसानिया (BHAISANIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भदौड़िया (BHADODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "भमोरिया (BHAMORIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बिनरोटिया (BINROTIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बीजलपुरिया (BIJALPURIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बिलावालिया (BILAVALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बड़बोदिया (BADABODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "सिरसोडिया (SIRSODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बबुलड़िया (BABULDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बरनवाया (BARANVAYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "बरनासिया (BARNASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "पंचोरिया (PANCHORIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "धनोरिया (DHANORIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "देवथलिया (DEVTHALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "देथलिया (DETHALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ठेंगलिया (THENGLIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "तुमड़िया (TUMDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "तंडिया (TAMDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "तिलवड़िया (TILVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ठीकरोडिया (THIKARODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "डिंगरोडिया (DINGRODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "झलवाया (JHALWAYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "जवारिया (JAVARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "जमलिया (JAMLIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कामोठीया (KAMOTHIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "जमगोड़िया (JAMGODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "जलोडिया (JALODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "चौरसिया (CHOURASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "चंदवासिया (CHANDVASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ग्वालिया (GWALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "गुरवादिया (GURAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "गिड़गिड़ाया (GIDGIDAYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "गिरितिया (GIRITIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "ख़िरबाड़ोदिया (KHIRABADODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "खचरोडिया (KHACHARODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "खरलिय (KHALIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "खेवसिया (KHEVASIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "खजुरिया (KHAJURIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "केलिए (KELIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कुलखंडिया (KULKHANDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कसंया (KASANYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "करंजिया (KARANJIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कसुन्दरिया (KASUNDARIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "कल्मोदिया (KALMODIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "करनावड़िया (KARNAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "उपलवड़िया (UPALAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "इटावदिया (ITAVDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "अकोलिया (AKOLIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "अम्लवाडिया (AMALAVDIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "अलेरिया (ALERIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": "अजनावडिया (AJNAVADIYA)",
    "clanName": null,
    "aaspadName": null
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "अमलावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "अजनावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "अजवास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "आलेरिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "असवारिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "आकोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बरंडवा"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बरनास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बाबड़ोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बीजलपुरिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "विदरोढ्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बीरोती"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बिजारया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बीजाल्या बींजाल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बिजावरया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बिलोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बामलोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "बिलाबल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "भमोरया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "भेंसोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "भेंसान्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "भवरास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "भदेडिया भेदड़ना"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "चौरास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "चितावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "चितावल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "चन्दवास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "छवड़ास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "देहथल्या भारेजा"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "देवदल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "डगग्या, डगरया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "दिलोद्रया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "डिगरोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "ठिकरोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "ढगा"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "ठुकरास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "डकनावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "इटावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गुनघोरिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गुवाल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गुटावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गुनघोड़ना"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गंगावत्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गागा, गागोत्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "गिरोढ्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "घुरावड्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "इछावारिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जामगोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जामल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जलोड्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जागल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जावरिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जवास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "जागोढ्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "झललावा, जलावा"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कनबाड़"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कनास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "करनावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कारंजया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कलमोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कैलोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कनारिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कामोद्या कामोडिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कासरन्या कासरन्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कुलखण्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कामोदया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "केल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "कसोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "केसोदन्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "खीरबड़ोदिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "खिवाल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "खजुरया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "खिवास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "खिरेल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "खाचरोदाय"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "मठोड़या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "मंडलावदया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "महारावदया."
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "मड़ोदया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "नागढोंदया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "नादोद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "पीपल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "पचौरया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "पलसावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रानावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रोहड़ावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रंडावद्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रिनोज्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रलियावना"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रुदाहेड़या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "रुघावड्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सोठोल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सिरसोदिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सिवदास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सिवास्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सुमटेहडया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सुमढया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सालोन्या, अलोन्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "स्वाग्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सनबान्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "सगबाल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "तिलावदिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "ताजपुरिया"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "थेगल्या"
  },
  {
    "communityName": "Chandravanshi Khati",
    "subCommunityName": null,
    "surnameName": null,
    "gotraName": null,
    "clanName": null,
    "aaspadName": "उपलावदिया"
  }
]
```
