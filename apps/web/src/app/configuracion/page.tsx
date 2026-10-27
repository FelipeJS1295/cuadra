"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2, UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ConnectionsPanel } from "@/components/connections";
import { CompanyForm, SiiForm } from "@/components/forms";
import { useSession } from "@/components/session";
import {
  Button,
  Card,
  dmy,
  ErrorBox,
  Field,
  inputCls,
  Loading,
  Modal,
  Page,
  Pill,
  Tabs,
} from "@/components/ui";
import { api, type UserRole } from "@/lib/api";

type Tab = "empresa" | "conexiones" | "sii" | "equipo" | "cuenta" | "plan";

const ROLES: Record<UserRole, { label: string; text: string }> = {
  DUENO: { label: "Dueño", text: "Todo, incluido el plan y las claves" },
  ADMIN: { label: "Administrador", text: "Todo menos el plan" },
  OPERADOR: {
    label: "Operador",
    text: "Sube archivos, emite boletas, registra pagos",
  },
  LECTURA: { label: "Solo mirar", text: "Ve todo, no cambia nada" },
};

export default function SettingsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Settings />
    </Suspense>
  );
}

function Settings() {
  const params = useSearchParams();
  const { isAdmin } = useSession();
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) ?? "empresa");
  // Si cambia ?tab= (ej: un enlace a Conexiones o al SII), se muestra esa pestaña
  useEffect(() => {
    const t = params.get("tab") as Tab | null;
    if (t) setTab(t);
  }, [params]);
  return (
    <Page title="Configuración">
      <div className="mb-6">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: "empresa", label: "Empresa" },
            { id: "conexiones", label: "Conexiones" },
            { id: "sii", label: "SII" },
            ...(isAdmin ? [{ id: "equipo" as Tab, label: "Equipo" }] : []),
            { id: "plan", label: "Plan" },
            { id: "cuenta", label: "Mi cuenta" },
          ]}
        />
      </div>
      {tab === "conexiones" ? (
        <ConnectionsPanel />
      ) : (
        <Card className="p-6">
          {tab === "empresa" && <CompanyForm />}
          {tab === "sii" && <SiiForm />}
          {tab === "equipo" && <Team />}
          {tab === "cuenta" && <Account />}
          {tab === "plan" && <Plan />}
        </Card>
      )}
    </Page>
  );
}

function Team() {
  const qc = useQueryClient();
  const { user } = useSession();
  const team = useQuery({ queryKey: ["team"], queryFn: api.team });
  const [inviting, setInviting] = useState(false);
  const update = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) =>
      api.updateMember(id, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
  const remove = useMutation({
    mutationFn: api.removeMember,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted">
          Las personas que pueden entrar a esta empresa.
        </p>
        <Button onClick={() => setInviting(true)}>
          <UserPlus className="size-4" /> Invitar
        </Button>
      </div>
      {team.isLoading && <Loading />}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {team.data?.map((m) => (
          <li
            key={m.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <div className="min-w-48 flex-1">
              <p className="font-medium">
                {m.name} {m.userId === user.id && <Pill>Tú</Pill>}
              </p>
              <p className="text-sm text-muted">
                {m.email} ·{" "}
                {m.lastLoginAt
                  ? `entró el ${dmy(m.lastLoginAt)}`
                  : "aún no entra"}
              </p>
            </div>
            <select
              value={m.role}
              onChange={(e) =>
                update.mutate({ id: m.id, role: e.target.value as UserRole })
              }
              disabled={m.userId === user.id}
              className={`${inputCls} w-44`}
            >
              {Object.entries(ROLES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            {m.userId !== user.id && (
              <button
                onClick={() =>
                  window.confirm(`¿Quitar a ${m.name} de la empresa?`) &&
                  remove.mutate(m.id)
                }
                className="rounded-xl p-2 text-muted hover:bg-berry-50 hover:text-berry-700"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox error={update.error ?? remove.error} />
      {inviting && <Invite onClose={() => setInviting(false)} />}
    </div>
  );
}

function Invite({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: "",
    email: "",
    role: "OPERADOR" as UserRole,
  });
  const save = useMutation({
    mutationFn: () => api.invite(f),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
  if (save.data) {
    return (
      <Modal
        title="Persona agregada"
        onClose={onClose}
        footer={<Button onClick={onClose}>Listo</Button>}
      >
        {save.data.tempPassword ? (
          <div className="space-y-2 text-sm">
            <p>
              Entrégale estos datos para que entre (la clave se muestra solo
              esta vez y deberá cambiarla):
            </p>
            <div className="rounded-xl bg-stone-50 p-4 font-mono">
              <p>Correo: {save.data.email}</p>
              <p>Clave temporal: {save.data.tempPassword}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                navigator.clipboard.writeText(
                  `Correo: ${save.data.email}\nClave temporal: ${save.data.tempPassword}`,
                )
              }
            >
              <Copy className="size-4" /> Copiar
            </Button>
          </div>
        ) : (
          <p className="text-sm">
            {save.data.email} ya tenía cuenta en Cuadra: ahora también puede
            entrar a esta empresa.
          </p>
        )}
      </Modal>
    );
  }
  return (
    <Modal
      title="Invitar a alguien"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!f.name || !f.email}
          >
            Agregar
          </Button>
        </>
      }
    >
      <Field label="Nombre">
        <input
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          className={inputCls}
        />
      </Field>
      <Field label="Correo">
        <input
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          className={inputCls}
        />
      </Field>
      <Field label="¿Qué puede hacer?" hint={ROLES[f.role].text}>
        <select
          value={f.role}
          onChange={(e) => setF({ ...f, role: e.target.value as UserRole })}
          className={inputCls}
        >
          {Object.entries(ROLES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
      <ErrorBox error={save.error} />
    </Modal>
  );
}

function Account() {
  const qc = useQueryClient();
  const { user } = useSession();
  const [f, setF] = useState({ current: "", next: "" });
  const save = useMutation({
    mutationFn: () => api.changePassword(f.current, f.next),
    onSuccess: () => {
      setF({ current: "", next: "" });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <div className="max-w-md space-y-4">
      <p className="text-muted">
        {user.name} · {user.email}
      </p>
      <Field label="Contraseña actual">
        <input
          type="password"
          value={f.current}
          onChange={(e) => setF({ ...f, current: e.target.value })}
          className={inputCls}
        />
      </Field>
      <Field label="Nueva contraseña" hint="Mínimo 8 caracteres">
        <input
          type="password"
          value={f.next}
          onChange={(e) => setF({ ...f, next: e.target.value })}
          className={inputCls}
        />
      </Field>
      <ErrorBox error={save.error} />
      <div className="flex items-center gap-3">
        <Button
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!f.current || f.next.length < 8}
        >
          Cambiar contraseña
        </Button>
        {save.isSuccess && (
          <span className="text-sm text-money-700">Listo</span>
        )}
      </div>
    </div>
  );
}

function Plan() {
  const company = useQuery({ queryKey: ["company"], queryFn: api.company });
  const c = company.data;
  if (!c) return <Loading />;
  const plans: Record<string, string> = {
    PRUEBA: "Prueba gratis",
    BASICO: "Básico",
    PRO: "Pro",
  };
  return (
    <div className="space-y-3">
      <p className="text-2xl font-semibold">{plans[c.plan] ?? c.plan}</p>
      {c.plan === "PRUEBA" && c.trialEndsAt && (
        <p className="text-muted">
          Tu prueba gratis dura hasta el {dmy(c.trialEndsAt)}.
        </p>
      )}
      <p className="text-sm text-muted">
        Para cambiar de plan escríbenos y lo activamos al tiro.
      </p>
    </div>
  );
}
