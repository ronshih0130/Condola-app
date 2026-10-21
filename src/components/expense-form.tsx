"use client";

import { useState } from "react";
import { ReceiptUpload } from "./receipt-upload";
import { useT } from "./locale";

type Option = { id: string; name: string };
type UnitOption = { id: string; propertyId: string; label: string };
type CategoryOption = { value: string; label: string };

export function ExpenseForm({
  action,
  properties,
  units,
  vendors,
  categories,
  defaults,
  lockFinancial,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  properties: Option[];
  units: UnitOption[];
  vendors: Option[];
  categories: CategoryOption[];
  defaults: {
    id?: string;
    propertyId: string;
    unitId: string;
    category: string;
    amount: string;
    incurredOn: string;
    vendorName: string;
    note: string;
    receiptId?: string;
    receiptName?: string;
    receiptSize?: number | null;
  };
  lockFinancial: boolean;
  submitLabel: string;
}) {
  const t = useT();
  const [propertyId, setPropertyId] = useState(defaults.propertyId);
  const [unitId, setUnitId] = useState(defaults.unitId);
  const visibleUnits = units.filter((unit) => unit.propertyId === propertyId);
  return (
    <form className="card pad" action={action} data-testid="expense-form" style={{ maxWidth: 640 }}>
      {defaults.id ? <input type="hidden" name="expenseId" value={defaults.id} /> : null}
      <div className="fg">
        <label className="f">{t("i_col_property")}</label>
        {lockFinancial ? <input type="hidden" name="propertyId" value={propertyId} /> : null}
        <select
          className="inp"
          name={lockFinancial ? undefined : "propertyId"}
          data-testid="expense-property"
          value={propertyId}
          disabled={lockFinancial}
          required
          onChange={(event) => {
            const next = event.target.value;
            setPropertyId(next);
            if (!units.some((unit) => unit.propertyId === next && unit.id === unitId)) setUnitId("");
          }}
        >
          <option value="">{t("i_choose")}</option>
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      </div>
      <div className="fg">
        <label className="f">{t("i_expense_unit")}</label>
        <select
          className="inp"
          name="unitId"
          data-testid="expense-unit"
          value={visibleUnits.some((unit) => unit.id === unitId) ? unitId : ""}
          onChange={(event) => setUnitId(event.target.value)}
        >
          <option value="">{t("i_expense_none")}</option>
          {visibleUnits.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
            </option>
          ))}
        </select>
      </div>
      <div className="fg">
        <label className="f">{t("i_category")}</label>
        <select className="inp" name="category" data-testid="expense-category" defaultValue={defaults.category} required>
          {categories.map((category) => (
            <option key={category.value} value={category.value}>
              {category.label}
            </option>
          ))}
        </select>
      </div>
      <div className="fg">
        <label className="f">{t("i_amount_label")}</label>
        {lockFinancial ? <input type="hidden" name="amount" value={defaults.amount} /> : null}
        <input
          className="inp"
          name={lockFinancial ? undefined : "amount"}
          data-testid="expense-amount"
          inputMode="decimal"
          defaultValue={defaults.amount}
          required
          disabled={lockFinancial}
        />
      </div>
      <div className="fg">
        <label className="f">{t("i_expense_date")}</label>
        {lockFinancial ? <input type="hidden" name="incurredOn" value={defaults.incurredOn} /> : null}
        <input
          className="inp"
          type="date"
          name={lockFinancial ? undefined : "incurredOn"}
          data-testid="expense-date"
          defaultValue={defaults.incurredOn}
          required
          disabled={lockFinancial}
        />
      </div>
      <div className="fg">
        <label className="f">{t("i_expense_vendor")}</label>
        <input
          className="inp"
          name="vendorName"
          data-testid="expense-vendor"
          list="expense-vendors"
          defaultValue={defaults.vendorName}
        />
        <datalist id="expense-vendors">
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.name} />
          ))}
        </datalist>
      </div>
      <div className="fg">
        <label className="f">{t("i_note")}</label>
        <input className="inp" name="note" data-testid="expense-note" defaultValue={defaults.note} />
      </div>
      <ReceiptUpload
        kind="expense"
        existing={
          defaults.receiptId && defaults.receiptName
            ? { id: defaults.receiptId, name: defaults.receiptName, size: defaults.receiptSize ?? null }
            : null
        }
      />
      <button className="btn pri" type="submit" data-testid="expense-save">
        {submitLabel}
      </button>
    </form>
  );
}
