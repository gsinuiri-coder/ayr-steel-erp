# UBL 2.1 — Factura electrónica SUNAT (Perú): guía de parseo

Investigación para prellenar una compra (y las bobinas de acero que trae) a partir del XML UBL 2.1
de la factura electrónica del proveedor. Hecha con consultas a Antigravity (`agy`, con búsqueda web),
contrastadas contra el conocimiento general del formato UBL/SUNAT. **No se descargó ni validó un XML
real emitido por SUNAT ni se abrió directamente el sitio cpe.sunat.gob.pe** — varias búsquedas de `agy`
contra dominios oficiales no encontraron resultado directo y la respuesta final se apoyó en su
conocimiento entrenado. Todo lo que cae en ese caso está marcado **NO verificado contra fuente oficial**
más abajo, aunque coincide con los patrones que se observan en implementaciones conocidas (Greenter y
otros PSE/OSE peruanos).

## 1. Namespaces del elemento raíz `Invoice`

| Prefijo   | URI                                                                            | Notas                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (default) | `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`                       | Namespace del elemento raíz `Invoice` mismo (sin prefijo).                                                                                                                  |
| `cbc`     | `urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2`         | Elementos simples: IDs, fechas, montos.                                                                                                                                     |
| `cac`     | `urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2`     | Elementos compuestos/agrupaciones: partes, impuestos, líneas.                                                                                                               |
| `ext`     | `urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2`     | Contenedor de extensiones (ahí vive la firma digital).                                                                                                                      |
| `ds`      | `http://www.w3.org/2000/09/xmldsig#`                                           | XML-DSig, firma digital (W3C, no es de UBL).                                                                                                                                |
| `qdt`     | `urn:oasis:names:specification:ubl:schema:xsd:QualifiedDatatypes-2`            | Opcional, generado por algunas librerías (ej. Greenter).                                                                                                                    |
| `udt`     | `urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule:2`  | Opcional.                                                                                                                                                                   |
| `ccts`    | `urn:un:unece:uncefact:documentation:2`                                        | Opcional.                                                                                                                                                                   |
| `sac`     | `urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1` | Extensiones peruanas heredadas de UBL 2.0; en UBL 2.1 casi todo migró a `cac`/`cbc` estándar, pero algunas librerías lo siguen declarando (retenciones, resúmenes diarios). |
| `xsi`     | `http://www.w3.org/2001/XMLSchema-instance`                                    | Estándar W3C.                                                                                                                                                               |

Solo los 5 primeros (default, `cbc`, `cac`, `ext`, `ds`) son estrictamente necesarios para leer una
factura. Los demás pueden faltar o variar de prefijo entre PSE/OSE — de ahí la recomendación de la
sección 5 de parsear ignorando el prefijo declarado (`local-name()`).

## 2. Rutas XPath — cabecera del comprobante

Todas las rutas son desde el elemento raíz `Invoice` (equivalentes a `/Invoice/...`).

| Dato                                             | XPath                                                                             | Notas                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RUC del emisor (proveedor)                       | `cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID`            | Atributo `@schemeID="6"` (RUC, catálogo 06).                                                                                                                                                                                                                                           |
| Razón social del emisor                          | `cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName` |                                                                                                                                                                                                                                                                                        |
| Nombre comercial del emisor (opcional)           | `cac:AccountingSupplierParty/cac:Party/cac:PartyName/cbc:Name`                    | Puede no existir.                                                                                                                                                                                                                                                                      |
| Doc. de identidad del receptor (nuestra empresa) | `cac:AccountingCustomerParty/cac:Party/cac:PartyIdentification/cbc:ID`            | Atributo `@schemeID` con código de catálogo 06 (6=RUC, 1=DNI, etc.).                                                                                                                                                                                                                   |
| Razón social / nombre del receptor               | `cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName` |                                                                                                                                                                                                                                                                                        |
| Serie-número del comprobante                     | `cbc:ID`                                                                          | Ver §2.1 — formato `SSSS-NNNNNNNN`.                                                                                                                                                                                                                                                    |
| Tipo de documento (catálogo 01)                  | `cbc:InvoiceTypeCode`                                                             | Ver §2.2.                                                                                                                                                                                                                                                                              |
| Fecha de emisión                                 | `cbc:IssueDate`                                                                   | Formato `YYYY-MM-DD`.                                                                                                                                                                                                                                                                  |
| Hora de emisión                                  | `cbc:IssueTime`                                                                   | Formato `HH:mm:ss`; obligatorio en factura/boleta.                                                                                                                                                                                                                                     |
| Fecha de vencimiento (cabecera)                  | `cbc:DueDate`                                                                     | Formato `YYYY-MM-DD`. Presente sobre todo en ventas al crédito; en crédito con varias cuotas, la fecha de vencimiento real de cada cuota vive en `cac:PaymentTerms/cbc:PaymentDueDate` (ver §2.4) — **no confíes solo en `cbc:DueDate` de cabecera si hay `PaymentTerms` con cuotas**. |
| Moneda del documento                             | `cbc:DocumentCurrencyCode`                                                        | `PEN`, `USD`, `EUR`. Atributo típico `listID="ISO 4217 Alpha"`.                                                                                                                                                                                                                        |

### 2.1 Serie y número (`cbc:ID`)

- Ruta: `/Invoice/cbc:ID`, directo bajo la raíz, sin anidar.
- Formato: `SERIE-CORRELATIVO`, separador siempre `-` (guion medio).
- La serie tiene 4 caracteres alfanuméricos; el correlativo, de 1 a 8 dígitos (ej. `F001-1`, `F001-00000001`).
- La primera letra de la serie indica el tipo de comprobante:
  - `F` = Factura electrónica
  - `B` = Boleta de venta electrónica
  - `E` = Recibo por honorarios electrónico
  - `T` = Guía de remisión electrónica — Remitente
  - `V` = Guía de remisión electrónica — Transportista
  - `R` = Comprobante de retención electrónico
  - `P` = Comprobante de percepción electrónico
- Para separar en código: `id.split('-')` — la serie es todo antes del primer guion, el correlativo todo lo que sigue. **NO verificado exhaustivamente** que nunca haya un guion adicional dentro del correlativo (no se confirmó contra la especificación técnica SUNAT oficial); en la práctica de los PSE conocidos siempre es un solo guion.

### 2.2 Tipo de documento (`cbc:InvoiceTypeCode`) y catálogo 01

- Ruta: `/Invoice/cbc:InvoiceTypeCode`.
- El **valor del nodo** (texto) es el código del **catálogo 01** (tipo de comprobante).
- El atributo `listID` (ej. `"0101"`) es el código del **catálogo 51** (tipo de operación: venta interna,
  exportación, etc.) — **no es el mismo catálogo que el valor del nodo**, es fácil confundirlos.
- Atributos típicos:
  ```xml
  <cbc:InvoiceTypeCode listID="0101" listAgencyName="PE:SUNAT" listName="Tipo de Documento"
      listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">01</cbc:InvoiceTypeCode>
  ```

**Catálogo 01 — Tipo de documento (código SUNAT)**

| Código | Descripción                                                             |
| ------ | ----------------------------------------------------------------------- |
| 01     | Factura                                                                 |
| 02     | Recibo por Honorarios                                                   |
| 03     | Boleta de Venta                                                         |
| 04     | Liquidación de compra                                                   |
| 05     | Boletos de Transporte Aéreo (Compañías de Aviación)                     |
| 06     | Carta de porte aéreo (transporte de carga aérea)                        |
| 07     | Nota de Crédito                                                         |
| 08     | Nota de Débito                                                          |
| 09     | Guía de Remisión — Remitente                                            |
| 12     | Ticket o cinta emitido por máquina registradora                         |
| 13     | Documentos emitidos por bancos, instituciones financieras y crediticias |
| 14     | Recibo por servicios públicos (luz, agua, teléfono)                     |
| 16     | Boleto de viaje — transporte público interprovincial                    |
| 20     | Comprobante de Retención                                                |
| 31     | Guía de Remisión — Transportista                                        |
| 40     | Comprobante de Percepción                                               |
| 41     | Comprobante de Percepción — Venta interna                               |
| 71     | Guía de remisión remitente complementaria                               |
| 72     | Guía de remisión transportista complementaria                           |

Nota importante: `07` (Nota de Crédito) y `08` (Nota de Débito) usan sus propios elementos raíz
(`<CreditNote>` y `<DebitNote>`, no `<Invoice>`), con rutas equivalentes bajo `/CreditNote/cbc:ID` o
`/DebitNote/cbc:ID`. Para el flujo de "compra a proveedor" el elemento raíz relevante normalmente es
`<Invoice>` (factura, código `01`). **Esta tabla no se contrastó contra el Anexo N.° 8 oficial descargado
de cpe.sunat.gob.pe; se marca como razonablemente confiable pero no verificada al 100%.**

### 2.3 Moneda

- Ruta: `/Invoice/cbc:DocumentCurrencyCode`.
- Valores típicos usados por proveedores peruanos: `PEN` (soles), `USD` (dólares). `EUR` es posible pero
  raro en compras nacionales.
- Atributos observados: `listID="ISO 4217 Alpha"`, `listAgencyName="United Nations Economic Commission for Europe"`.

### 2.4 Forma de pago — `cac:PaymentTerms` (contado vs. crédito)

- Ruta: `/Invoice/cac:PaymentTerms` — puede repetirse (0, 1 o varios bloques).
- **Contado**: un solo bloque.
  ```xml
  <cac:PaymentTerms>
    <cbc:ID>FormaPago</cbc:ID>
    <cbc:PaymentMeansID>Contado</cbc:PaymentMeansID>
  </cac:PaymentTerms>
  ```
- **Crédito**: un bloque principal + un bloque por cuota.
  - `cbc:ID` es siempre el literal `FormaPago` en todos los bloques (no es una clave única por cuota).
  - Bloque principal: `cbc:PaymentMeansID` = `Credito`, `cbc:Amount` = monto neto pendiente de pago
    (total del crédito, ya descontando retención/detracción si aplica).
  - Bloques de cuota: `cbc:PaymentMeansID` = `Cuota001`, `Cuota002`, ... (correlativo), `cbc:Amount` =
    monto de esa cuota, `cbc:PaymentDueDate` = fecha de vencimiento de esa cuota (`YYYY-MM-DD`).
  - La suma de los montos de las cuotas debe cuadrar con el monto del bloque principal.
- Para distinguir contado/crédito en código: buscar el `cac:PaymentTerms` cuyo `cbc:PaymentMeansID` sea
  literalmente `"Contado"` o `"Credito"` (sin tilde). Si es `Credito`, la fecha de vencimiento de la
  primera cuota (o la única relevante para el proceso) sale de los bloques `Cuota00N`, no de
  `cbc:DueDate` de cabecera.

**Ejemplo de crédito con 2 cuotas** (montos de referencia):

```xml
<cac:PaymentTerms>
  <cbc:ID>FormaPago</cbc:ID>
  <cbc:PaymentMeansID>Credito</cbc:PaymentMeansID>
  <cbc:Amount currencyID="PEN">3000.00</cbc:Amount>
</cac:PaymentTerms>
<cac:PaymentTerms>
  <cbc:ID>FormaPago</cbc:ID>
  <cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID>
  <cbc:Amount currencyID="PEN">1500.00</cbc:Amount>
  <cbc:PaymentDueDate>2026-10-15</cbc:PaymentDueDate>
</cac:PaymentTerms>
<cac:PaymentTerms>
  <cbc:ID>FormaPago</cbc:ID>
  <cbc:PaymentMeansID>Cuota002</cbc:PaymentMeansID>
  <cbc:Amount currencyID="PEN">1500.00</cbc:Amount>
  <cbc:PaymentDueDate>2026-11-15</cbc:PaymentDueDate>
</cac:PaymentTerms>
```

**NO verificado contra la Resolución de Superintendencia oficial** (se citó N° 193-2020/SUNAT como
origen normativo, pero no se abrió el texto de la RS para confirmar el número exacto).

### 2.5 Tipo de cambio (USD)

**Conclusión importante: el UBL 2.1 de SUNAT NO incluye un nodo estructural de tipo de cambio en la
factura misma.** No existe `cac:PaymentExchangeRate` ni `cac:TaxExchangeRate` obligatorio en `<Invoice>`
para SUNAT (aunque el estándar UBL genérico sí define esas etiquetas y otros países SI las usan).

- Si la factura se emite en USD, **todos** los importes del XML (línea, `TaxTotal`, `LegalMonetaryTotal`)
  van exclusivamente en USD — no se mezclan monedas dentro del mismo documento.
- El tipo de cambio para contabilizar en soles se maneja **fuera** del XML de la factura: se usa el tipo
  de cambio venta publicado por la SBS a la fecha de emisión, y esa conversión la hace el sistema
  contable del comprador al momento de registrar la compra (PLE/SIRE), no SUNAT ni el XML.
- Como dato informativo (no estructural, solo texto libre para el PDF), algunos emisores agregan el tipo
  de cambio en una leyenda: `cbc:Note[@languageLocaleID="2006"]`, ej.
  `<cbc:Note languageLocaleID="2006">TIPO DE CAMBIO: 3.750</cbc:Note>`. Esto **no es parseable de forma
  fiable** (es texto libre) y SUNAT no lo usa para cálculos.
- El nodo `cac:ExchangeRate` sí es exigido por SUNAT, pero solo en Comprobantes de Retención/Percepción
  electrónicos, no en facturas de compra comerciales — **irrelevante para el caso de uso actual**.
- **Implicación para el sistema**: si necesitamos el tipo de cambio para una compra en USD, hay que
  buscarlo aparte (tabla de tipo de cambio SBS/SUNAT publicada diariamente), no se puede extraer del XML.

**NO verificado con una fuente primaria SUNAT específica** (normativa de tipo de cambio en comprobantes);
la conclusión de "no existe en el XML" es consistente y fue confirmada por varias búsquedas fallidas de
`agy` contra el propio nodo (`cac:PaymentExchangeRate`, `cbc:SourceCurrencyBaseRate`), lo cual es evidencia
indirecta razonable pero no una cita directa de la norma.

## 3. Rutas XPath — `cac:InvoiceLine` (por cada línea/ítem)

Rutas relativas a cada nodo `cac:InvoiceLine` (hay uno por cada línea/ítem de la factura).

| Dato                                                    | XPath relativo                                                            | Notas                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Número de línea                                         | `cbc:ID`                                                                  | Correlativo 1, 2, 3...                                                                                     |
| Cantidad                                                | `cbc:InvoicedQuantity`                                                    | Texto numérico — **leer como string**.                                                                     |
| Unidad de medida (catálogo 03)                          | `cbc:InvoicedQuantity/@unitCode`                                          | Ej. `KGM`, `NIU`, `TNE`. Ver §4.2.                                                                         |
| Descripción del ítem                                    | `cac:Item/cbc:Description`                                                |                                                                                                            |
| Código del producto (proveedor)                         | `cac:Item/cac:SellersItemIdentification/cbc:ID`                           | Puede no existir.                                                                                          |
| Precio unitario SIN IGV                                 | `cac:Price/cbc:PriceAmount`                                               | Atributo `@currencyID`.                                                                                    |
| Precio unitario CON IGV (o valor referencial)           | `cac:PricingReference/cac:AlternativeConditionPrice/cbc:PriceAmount`      | **Ojo**: `AlternativeConditionPrice` vive dentro de `cac:PricingReference`, no directo bajo `InvoiceLine`. |
| Tipo del precio alternativo (catálogo 16)               | `cac:PricingReference/cac:AlternativeConditionPrice/cbc:PriceTypeCode`    | `01` = precio unitario incluye IGV; `02` = valor referencial en operaciones no onerosas/gratuitas.         |
| Valor de venta de la línea (sin IGV)                    | `cbc:LineExtensionAmount`                                                 | Ya neto de descuentos de línea si los hay.                                                                 |
| IGV total de la línea                                   | `cac:TaxTotal/cbc:TaxAmount`                                              | Suma de impuestos de la línea (normalmente solo IGV).                                                      |
| Base imponible de la línea (subtotal del `TaxSubtotal`) | `cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount`                          |                                                                                                            |
| Monto IGV del `TaxSubtotal`                             | `cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount`                              |                                                                                                            |
| Porcentaje del IGV (ej. 18.00)                          | `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent`                |                                                                                                            |
| Código de tipo de afectación IGV (catálogo 07)          | `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReasonCode` | `10` = Gravado - Operación Onerosa; `20` = Exonerado; `30` = Inafecto; `11`-`17` = Gravado - Retiro.       |
| Código de esquema de impuesto (catálogo 05)             | `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cac:TaxScheme/cbc:ID`       | `1000` = IGV. Sirve para filtrar y aislar el IGV si hubiera ISC/ICBPER mezclados.                          |

### 3.1 Estructura de ejemplo de una línea (con IGV gravado 18%)

```xml
<cac:InvoiceLine>
  <cbc:ID>1</cbc:ID>
  <cbc:InvoicedQuantity unitCode="KGM">5000.000</cbc:InvoicedQuantity>
  <cbc:LineExtensionAmount currencyID="PEN">21200.0000</cbc:LineExtensionAmount>
  <cac:PricingReference>
    <cac:AlternativeConditionPrice>
      <cbc:PriceAmount currencyID="PEN">5.0032</cbc:PriceAmount>
      <cbc:PriceTypeCode>01</cbc:PriceTypeCode>
    </cac:AlternativeConditionPrice>
  </cac:PricingReference>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="PEN">3816.0000</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="PEN">21200.0000</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="PEN">3816.0000</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>18.00</cbc:Percent>
        <cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>
        <cac:TaxScheme>
          <cbc:ID>1000</cbc:ID>
          <cbc:Name>IGV</cbc:Name>
          <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:Item>
    <cbc:Description>BOBINA LAC ESPESOR 2.00MM x 1220MM</cbc:Description>
    <cac:SellersItemIdentification>
      <cbc:ID>BOB-LAC-200</cbc:ID>
    </cac:SellersItemIdentification>
  </cac:Item>
  <cac:Price>
    <cbc:PriceAmount currencyID="PEN">4.2400</cbc:PriceAmount>
  </cac:Price>
</cac:InvoiceLine>
```

## 4. Totales del documento

Rutas desde `Invoice`:

| Dato                                           | XPath                                                      | Notas                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valor de venta (gravado, base sin impuestos)   | `cac:LegalMonetaryTotal/cbc:LineExtensionAmount`           |                                                                                                                                                               |
| Importe total con impuestos                    | `cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount`            |                                                                                                                                                               |
| Total de descuentos globales                   | `cac:LegalMonetaryTotal/cbc:AllowanceTotalAmount`          | Solo si hay `cac:AllowanceCharge` de cabecera.                                                                                                                |
| Total de cargos globales                       | `cac:LegalMonetaryTotal/cbc:ChargeTotalAmount`             |                                                                                                                                                               |
| Importe total a pagar                          | `cac:LegalMonetaryTotal/cbc:PayableAmount`                 | Este es el que debe cuadrar con la suma de `cac:PaymentTerms`.                                                                                                |
| Total IGV (y otros tributos) a nivel documento | `cac:TaxTotal/cbc:TaxAmount`                               | Suma de todos los tributos (IGV + ISC + ICBPER si aplica). Para aislar solo IGV, filtrar por `cac:TaxSubtotal/cac:TaxCategory/cac:TaxScheme/cbc:ID = '1000'`. |
| Descuentos/cargos globales (detalle)           | `cac:AllowanceCharge` (hijo directo de `Invoice`, 0 o más) | Ver abajo.                                                                                                                                                    |

`cac:AllowanceCharge` de cabecera:

- `cbc:ChargeIndicator`: `false` = descuento, `true` = cargo.
- `cbc:AllowanceChargeReasonCode`: código del catálogo 53 SUNAT (ej. `02`/`03` para descuentos que
  afectan/no afectan base imponible; `47`/`50` para cargos).
- `cbc:MultiplierFactorNumeric`: porcentaje en decimal (ej. `0.10` = 10%), opcional.
- `cbc:Amount` / `cbc:BaseAmount`: montos con `@currencyID`.

**NO verificado contra el Anexo del catálogo 53** (solo se citaron ejemplos de códigos, no la lista
completa oficial).

### 4.1 Catálogo 06 — Tipo de documento de identidad

| Código | Descripción                                                          |
| ------ | -------------------------------------------------------------------- |
| 0      | Doc. tributario no domiciliado sin RUC                               |
| 1      | Documento Nacional de Identidad (DNI)                                |
| 4      | Carné de extranjería                                                 |
| 6      | Registro Único de Contribuyentes (RUC)                               |
| 7      | Pasaporte                                                            |
| A      | Cédula Diplomática de Identidad                                      |
| B      | Doc. de identidad país de residencia — no domiciliado                |
| C      | Tax Identification Number (TIN) — doc. tributario personas naturales |
| D      | Identification Number (IN) — doc. tributario personas jurídicas      |
| E      | TAM — Tarjeta Andina de Migración                                    |
| F      | Permiso Temporal de Permanencia (PTP)                                |
| G      | Salvoconducto                                                        |
| H      | Carné de Permiso Temporal de Permanencia (CPP)                       |

**NO verificado contra la publicación oficial de SUNAT** (Anexo N.° 8, resoluciones de superintendencia).
`agy` no logró abrir directamente `cpe.sunat.gob.pe` ni un PDF/Excel oficial en sus búsquedas; esta lista
sale de su conocimiento entrenado. Para el flujo de negocio de AYR (proveedores casi siempre con RUC,
código `6`), el riesgo de un código incorrecto en esta tabla es bajo, pero **antes de codificar
validaciones estrictas sobre este catálogo conviene confirmarlo contra el Anexo 8 oficial**.

### 4.2 Catálogo 03 — Unidades de medida (relevantes para acero/comercio)

Basado en UN/ECE Recommendation 20.

| Código | Descripción                    | Uso típico                                                                                                  |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| KGM    | Kilogramo                      | Venta de acero por peso (bobinas, planchas).                                                                |
| NIU    | Unidad                         | Código estándar peruano para "unidad" de un bien físico — **es el que se usa normalmente, no `ZZ` ni `U`**. |
| TNE    | Tonelada métrica               | Venta mayorista de acero.                                                                                   |
| MTR    | Metro                          | Tubos, perfiles, barras vendidos por longitud.                                                              |
| MTK    | Metro cuadrado                 | Planchas/bobinas vendidas por superficie.                                                                   |
| MTQ    | Metro cúbico                   | Volumen.                                                                                                    |
| GRM    | Gramo                          | Poco común en acero, más en insumos menores.                                                                |
| ZZ     | Servicio / mutuamente definido | Reservado para **servicios** (ej. corte, maquila), no para bienes.                                          |
| BX     | Caja                           | Pernos, clavos, insumos en caja.                                                                            |
| SET    | Juego / conjunto               | Kits, ensamblajes.                                                                                          |
| C62    | Pieza / uno                    | Alternativa a `NIU`, más común en contexto aduanero (importación/exportación).                              |

Importante: **`U` no es un código válido** del catálogo 03 SUNAT — es solo una abreviatura comercial que
algunos ERPs imprimen en el PDF, pero el XML siempre debe traer un código real (`NIU`, `KGM`, etc.); si el
parser encuentra `U` como `unitCode`, es indicio de un XML mal formado o no proveniente de SUNAT.

**NO verificado contra la publicación oficial del catálogo 03** por la misma razón que el catálogo 06 —
conocimiento entrenado de `agy`, consistente con el estándar UN/ECE Rec. 20 pero sin cita directa a la
fuente peruana (Resolución N.° 097-2012/SUNAT y modificatorias, según lo que citó `agy` sin verificar el
número exacto).

## 5. Detalles prácticos de parseo

### 5.1 ZIP y firma digital

- **El XML puede venir dentro de un ZIP** en varios puntos del flujo:
  - Al enviarse a SUNAT/OSE: el envío exige el XML comprimido en `.zip` y codificado en Base64.
  - La respuesta (CDR — Constancia de Recepción) de SUNAT también viene en `.zip`.
  - En distribución proveedor→cliente (ej. adjunto de correo), es común recibir un `.zip` que contiene el
    XML y el PDF (representación impresa) juntos.
  - **Implicación**: el importador de compras debe soportar tanto `.xml` suelto como `.zip` (descomprimir
    en memoria y buscar la entrada `.xml` dentro, ignorando el PDF si viene junto).
- **La firma digital vive dentro de `ext:UBLExtensions`**, en la ruta:
  `/Invoice/ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent/ds:Signature` — el nodo
  `ds:Signature` (namespace `http://www.w3.org/2000/09/xmldsig#`) es hijo directo de `ext:ExtensionContent`.
- **No hace falta remover ni tratar especialmente el bloque de firma** para leer los datos de negocio: es
  XML válido como cualquier otro nodo, un parser estándar lo procesa sin problema — basta con no navegar
  a esa rama del árbol al mapear los DTOs. Solo sería necesario si en el futuro se quisiera **validar
  criptográficamente** la firma (para eso se necesitaría una librería aparte tipo `xml-crypto`, fuera de
  alcance del caso de uso actual de "prellenar una compra").

### 5.2 Namespaces variables — parsear con `local-name()`

Como los prefijos de namespace (`cbc`, `cac`, etc.) son solo alias declarados en cada documento, distintos
proveedores/PSE podrían (en teoría) usar otros prefijos aunque las URIs sean las mismas. Para robustez,
conviene resolver por **URI de namespace + nombre local**, o al menos por nombre local ignorando el
prefijo (`removeNSPrefix` en `fast-xml-parser`, o `local-name()` en XPath), en vez de asumir literalmente
`cac:`/`cbc:` como cadenas fijas. Esto es una práctica de robustez general, no algo confirmado como
problema real en los XML peruanos (en la práctica, todos los PSE conocidos usan `cbc`/`cac`/`ext` tal
cual).

### 5.3 Riesgos de seguridad al parsear XML de terceros

- **XXE (XML External Entity)**: si el parser soporta `<!DOCTYPE>` con entidades externas, un XML
  malicioso puede forzar la lectura de archivos locales (`file:///etc/passwd`) o SSRF contra servicios
  internos (ej. metadata de la nube) filtrando el contenido dentro de los campos parseados.
- **Billion laughs / entity expansion (DoS)**: entidades DTD que se referencian entre sí exponencialmente;
  un payload de pocos KB puede expandirse a gigabytes en memoria y tumbar el proceso Node (OOM) o
  bloquear el event loop.

**Librería recomendada: `fast-xml-parser`.**

- Es un parser no validante que **no procesa DTD/`<!DOCTYPE>` con expansión de entidades por diseño**, lo
  que lo hace estructuralmente resistente a XXE y billion-laughs sin depender de una opción que alguien
  pueda desactivar por error. Aun así, hay que fijar explícitamente la opción de procesamiento de
  entidades en `false` como defensa en profundidad (no confiar solo en el comportamiento por defecto).
  `agy` citó una vulnerabilidad histórica de DoS por expansión de entidades en versiones antiguas
  (referida como "CVE-2023-39325") — **este identificador de CVE específico no fue verificado
  independientemente por el investigador** contra la base de datos NVD; tratarlo como una señal de que
  conviene fijar `processEntities: false` explícitamente y mantener la librería actualizada, no como un
  hecho confirmado con ese número exacto.
- Configuración recomendada para este caso de uso:
  ```js
  import { XMLParser } from 'fast-xml-parser';

  const parser = new XMLParser({
    // Seguridad: sin expansión de entidades/DTD.
    processEntities: false,

    // Precisión financiera: nunca convertir a number nativo de JS.
    parseTagValue: false,
    parseAttributeValue: false,

    // Necesario para leer currencyID, unitCode, schemeID, etc.
    ignoreAttributes: false,
    attributeNamePrefix: '@_',

    // Namespaces: aplanar cbc:/cac:/ext: para no depender del prefijo literal.
    removeNSPrefix: true,

    trimValues: true,
    allowBooleanAttributes: false,
  });
  ```
  Con `parseTagValue: false` y `parseAttributeValue: false`, todo monto (`PriceAmount`,
  `LineExtensionAmount`, `PayableAmount`, `InvoicedQuantity`, etc.) llega como **string**, listo para
  pasar a `Decimal`/`money()`/`kg()`/`mm()` de `@ayr/shared` — cumple la regla dura D-003 del proyecto de
  nunca operar dinero/kg/mm como `number`.
  Sugerencia de integración con NestJS: mapear el JSON crudo a un DTO con `class-transformer`, usando
  `@Transform(({ value }) => new Decimal(value))` en cada campo monetario/de cantidad.

**Alternativas evaluadas** (según lo que reportó `agy`, no verificado con benchmarks propios):

| Librería                  | Seguridad ante XML no confiable                                                                                                                                                                       | Namespaces / XPath                                             | Uso recomendado                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `fast-xml-parser`         | Buena por diseño (no procesa DTD); requiere fijar `processEntities: false` explícito.                                                                                                                 | Aplana con `removeNSPrefix`, no ofrece XPath real (solo JSON). | **Recomendada** — rápida, sin dependencias nativas, control fino de tipos string.                                              |
| `xml2js` (sobre `sax-js`) | Buena — el parser SAX subyacente ignora DTD/entidades externas por diseño.                                                                                                                            | Namespaces quedan como texto (`cbc:ID`), sin XPath.            | Alternativa válida si se prefiere su forma de mapear a arrays; más lenta y verbosa que `fast-xml-parser`.                      |
| `libxmljs2`               | Riesgosa si no se configura con cuidado — bindings a `libxml2` en C, con historial de vulnerabilidades (buffer overflows, XXE); la opción `noent: true` de hecho _habilita_ sustitución de entidades. | Soporte completo de XPath real y validación XSD.               | Solo si se necesita XPath/XSD real y se audita la configuración cuidadosamente; no es la primera opción para XML no confiable. |
| `@xmldom/xmldom`          | Riesgosa — múltiples CVEs recientes (2021-2024) relacionados con XXE y manejo de CDATA/memoria.                                                                                                       | Emula DOM del navegador.                                       | Evitar para XML no confiable.                                                                                                  |
| `sax` (`sax-js`)          | La más segura (parser de streaming puro, sin DTD).                                                                                                                                                    | Solo eventos de bajo nivel, sin árbol ni XPath.                | Útil para archivos muy grandes, pero mucho más trabajo de desarrollo para este caso.                                           |

**NO verificado independientemente por el investigador**: los CVEs y vulnerabilidades históricas
mencionadas arriba (`@xmldom/xmldom`, `libxmljs2`, el CVE citado de `fast-xml-parser`) provienen de la
respuesta de `agy` y no se confirmaron contra NVD/GitHub Advisories directamente. Antes de fijar versiones
en `package.json`, correr `pnpm audit` / revisar advisories de la versión exacta a instalar.

## 6. Fixture XML de ejemplo (factura de proveedor, 2 líneas, contado, PEN)

Fixture mínimo pero realista para tests, con RUC ficticio (no corresponde a una empresa real) y montos
de bobinas de acero como ejemplo de dominio.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
         xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <!-- Firma digital XML-DSig del emisor. Se ignora al leer datos de negocio. -->
        <ds:Signature Id="SignSUNAT">
          <ds:SignedInfo>...</ds:SignedInfo>
          <ds:SignatureValue>...</ds:SignatureValue>
          <ds:KeyInfo>...</ds:KeyInfo>
        </ds:Signature>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>

  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>F001-1523</cbc:ID>
  <cbc:IssueDate>2026-08-20</cbc:IssueDate>
  <cbc:IssueTime>09:15:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode listID="0101" listAgencyName="PE:SUNAT" listName="Tipo de Documento"
      listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode listID="ISO 4217 Alpha" listName="Currency"
      listAgencyName="United Nations Economic Commission for Europe">PEN</cbc:DocumentCurrencyCode>

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="6" schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT"
            schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06">20601234567</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name><![CDATA[ACEROS DEL NORTE]]></cbc:Name>
      </cac:PartyName>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName><![CDATA[ACEROS DEL NORTE S.A.C.]]></cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="6" schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT"
            schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06">20512345678</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName><![CDATA[AYR STEEL S.A.C.]]></cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:PaymentTerms>
    <cbc:ID>FormaPago</cbc:ID>
    <cbc:PaymentMeansID>Contado</cbc:PaymentMeansID>
  </cac:PaymentTerms>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="PEN">4356.0000</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="PEN">24200.0000</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="PEN">4356.0000</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>18.00</cbc:Percent>
        <cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>
        <cac:TaxScheme>
          <cbc:ID>1000</cbc:ID>
          <cbc:Name>IGV</cbc:Name>
          <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="PEN">24200.0000</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="PEN">28556.0000</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="PEN">28556.0000</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="KGM">5000.000</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PEN">21200.0000</cbc:LineExtensionAmount>
    <cac:PricingReference>
      <cac:AlternativeConditionPrice>
        <cbc:PriceAmount currencyID="PEN">5.0032</cbc:PriceAmount>
        <cbc:PriceTypeCode>01</cbc:PriceTypeCode>
      </cac:AlternativeConditionPrice>
    </cac:PricingReference>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="PEN">3816.0000</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="PEN">21200.0000</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="PEN">3816.0000</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>18.00</cbc:Percent>
          <cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>
          <cac:TaxScheme>
            <cbc:ID>1000</cbc:ID>
            <cbc:Name>IGV</cbc:Name>
            <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description><![CDATA[BOBINA LAMINADO EN CALIENTE (LAC) 2.00MM x 1220MM]]></cbc:Description>
      <cac:SellersItemIdentification>
        <cbc:ID>BOB-LAC-200</cbc:ID>
      </cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="PEN">4.2400</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>

  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="KGM">1500.000</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PEN">3000.0000</cbc:LineExtensionAmount>
    <cac:PricingReference>
      <cac:AlternativeConditionPrice>
        <cbc:PriceAmount currencyID="PEN">2.3600</cbc:PriceAmount>
        <cbc:PriceTypeCode>01</cbc:PriceTypeCode>
      </cac:AlternativeConditionPrice>
    </cac:PricingReference>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="PEN">540.0000</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="PEN">3000.0000</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="PEN">540.0000</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>18.00</cbc:Percent>
          <cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>
          <cac:TaxScheme>
            <cbc:ID>1000</cbc:ID>
            <cbc:Name>IGV</cbc:Name>
            <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description><![CDATA[BOBINA GALVANIZADA 1.50MM x 1000MM]]></cbc:Description>
      <cac:SellersItemIdentification>
        <cbc:ID>BOB-GAL-150</cbc:ID>
      </cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="PEN">2.0000</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>
```

## 7. Resumen de bloqueos / lo NO verificado

- No se abrió directamente `cpe.sunat.gob.pe` ni se descargó el Anexo N.° 8 oficial (catálogos 01, 03, 05,
  06, 07, 16, 51, 53) — las tablas de este documento vienen del conocimiento entrenado de `agy`,
  contrastado por el investigador contra su propio conocimiento general de UBL/SUNAT, pero no contra el
  documento fuente. Antes de usar estas tablas para _rechazar_ comprobantes (validación estricta), conviene
  bajar el Anexo 8 real y confirmarlas.
- El número exacto de la Resolución de Superintendencia que originó el uso obligatorio de `PaymentTerms`
  para contado/crédito (citada como "N° 193-2020/SUNAT") no se verificó contra el texto de la norma.
  Tratar el número como orientativo, no confirmado.
  - Los CVEs/vulnerabilidades históricas citadas para `fast-xml-parser`, `@xmldom/xmldom` y `libxmljs2`
    (sección 5.3) no se verificaron contra NVD/GitHub Advisories — son afirmaciones de `agy`, razonables
    pero no confirmadas con el identificador exacto.
- Ninguna de las 8 consultas a `agy` falló las 3 veces (una consulta falló una vez por permisos al intentar
  ejecutar código de prueba; se reformuló para pedir respuesta solo por conocimiento/búsqueda web y
  respondió correctamente en el reintento) — no hay bloqueos duros que impidan avanzar con la
  implementación, solo los puntos de verificación pendientes listados arriba.

## 8. Fuentes

- Respuestas de Antigravity (`agy`, modelo con búsqueda web) — 8 consultas realizadas el 2026-09-02,
  sintetizando conocimiento general de UBL 2.1 y patrones observados en implementaciones peruanas
  conocidas (Greenter y otros PSE/OSE). No se obtuvieron URLs de citas directas verificables para la
  mayoría de las respuestas (varias búsquedas contra `sunat.gob.pe`/`cpe.sunat.gob.pe` no dieron resultado
  útil), por lo que se marcó explícitamente cada sección con nivel de verificación.
- Especificación general OASIS UBL 2.1 (`urn:oasis:names:specification:ubl:schema:xsd:*`) — namespaces
  contrastados contra conocimiento propio del formato UBL, consistentes con el estándar OASIS público.
- UN/ECE Recommendation 20 (Codes for Units of Measure Used in International Trade) — base del catálogo 03
  SUNAT, mencionada por `agy` sin verse el documento fuente directamente.
- Documentación de `fast-xml-parser` (opciones `processEntities`, `parseTagValue`, `parseAttributeValue`,
  `removeNSPrefix`, etc.) — citada por `agy` según su conocimiento de la librería; no se abrió el repo
  oficial (`github.com/NaturalIntelligence/fast-xml-parser`) para confirmar los nombres exactos de las
  opciones en la versión que finalmente se instale — **verificar contra el README de la versión pineada
  en `package.json` antes de usar en producción**.
