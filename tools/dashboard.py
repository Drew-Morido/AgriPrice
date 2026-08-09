import os
from datetime import datetime

import customtkinter as ctk
import pandas as pd
from tkinter import ttk

# =============================================================================
# THEME
# =============================================================================
ctk.set_appearance_mode("Light")
ctk.set_default_color_theme("blue")

CLR_SIDEBAR_BG    = "#1E2A3A"
CLR_SIDEBAR_TEXT  = "#CBD5E1"
CLR_ACCENT        = "#3B82F6"
CLR_SURFACE       = "#FFFFFF"
CLR_SURFACE_ALT   = "#F1F5F9"
CLR_BORDER        = "#E2E8F0"
CLR_TEXT_PRIMARY  = "#0F172A"
CLR_TEXT_MUTED    = "#64748B"
CLR_SUCCESS       = "#15803D"
CLR_WARNING       = "#B45309"
CLR_ROW_ODD       = "#F8FAFC"
CLR_ROW_EVEN      = "#FFFFFF"
CLR_ROW_SEL       = "#DBEAFE"
AUTO_REFRESH_MS   = 60000


class AgriDashboard(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("AgriPrice LSTM Forecasting System")
        self.geometry("1280x760")
        self.minsize(980, 620)
        self.configure(fg_color=CLR_SURFACE_ALT)

        base = os.path.dirname(os.path.abspath(__file__))
        self.datasets = {
            "rice": (
                os.path.join(base, "scrapped price", "agriprice_database.csv"),
                "Rice Prices",
                "Department of Agriculture daily rice prices",
                "🌾",
            ),
            "rate": (
                os.path.join(base, "scrapped rate", "exchange_rate_database.csv"),
                "Exchange Rates",
                "USD, THB, and VND against PHP",
                "💱",
            ),
            "fuel": (
                os.path.join(base, "scrapped fuel", "fuel_database.csv"),
                "Fuel Prices",
                "Daily fuel prices collected from the source website",
                "⛽",
            ),
        }
        self.active_key = "rice"

        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        self._build_sidebar()
        self._build_main()
        self._on_nav_click(self.active_key)
        self.after(AUTO_REFRESH_MS, self._auto_refresh)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # -----------------------------------------------------------------
    # Layout
    # -----------------------------------------------------------------
    def _build_sidebar(self):
        sb = ctk.CTkFrame(self, width=240, corner_radius=0, fg_color=CLR_SIDEBAR_BG)
        sb.grid(row=0, column=0, sticky="nsew")
        sb.grid_propagate(False)
        sb.grid_rowconfigure(7, weight=1)

        brand = ctk.CTkFrame(sb, fg_color="transparent")
        brand.grid(row=0, column=0, padx=24, pady=(28, 24), sticky="ew")

        ctk.CTkLabel(
            brand,
            text="AgriPrice",
            text_color="#FFFFFF",
            font=ctk.CTkFont(family="Georgia", size=20, weight="bold"),
        ).grid(row=0, column=0, sticky="w")

        ctk.CTkLabel(
            brand,
            text="LSTM Forecasting Dashboard",
            text_color=CLR_SIDEBAR_TEXT,
            font=ctk.CTkFont(size=10),
        ).grid(row=1, column=0, sticky="w", pady=(2, 0))

        ctk.CTkFrame(sb, height=1, fg_color="#2D3F55").grid(
            row=1, column=0, sticky="ew", padx=20, pady=(0, 18)
        )

        ctk.CTkLabel(
            sb,
            text="DATASETS",
            text_color="#4A6278",
            font=ctk.CTkFont(size=10, weight="bold"),
        ).grid(row=2, column=0, padx=24, sticky="w", pady=(0, 8))

        self.nav_buttons = {}
        for i, (key, (_, label, desc, icon)) in enumerate(self.datasets.items()):
            btn = self._make_nav_btn(sb, key, icon, label, desc)
            btn.grid(row=3 + i, column=0, padx=12, pady=3, sticky="ew")
            self.nav_buttons[key] = btn

        footer = ctk.CTkFrame(sb, fg_color="transparent")
        footer.grid(row=8, column=0, padx=20, pady=20, sticky="sew")
        ctk.CTkButton(
            footer,
            text="Exit Application",
            fg_color="transparent",
            border_width=1,
            border_color="#2D3F55",
            text_color=CLR_SIDEBAR_TEXT,
            hover_color="#2D3F55",
            corner_radius=6,
            height=34,
            font=ctk.CTkFont(size=12),
            command=self._on_close,
        ).pack(fill="x")

    def _make_nav_btn(self, parent, key, icon, label, desc):
        frame = ctk.CTkFrame(parent, fg_color="transparent", corner_radius=8)
        frame.grid_columnconfigure(1, weight=1)

        widgets = []
        icon_lbl = ctk.CTkLabel(frame, text=icon, font=ctk.CTkFont(size=18), width=32)
        icon_lbl.grid(row=0, column=0, rowspan=2, padx=(10, 6), pady=8)
        widgets.append(icon_lbl)

        title_lbl = ctk.CTkLabel(
            frame,
            text=label,
            text_color="#E2E8F0",
            font=ctk.CTkFont(size=13, weight="bold"),
            anchor="w",
        )
        title_lbl.grid(row=0, column=1, sticky="w")
        widgets.append(title_lbl)

        desc_lbl = ctk.CTkLabel(
            frame,
            text=desc,
            text_color="#4A6278",
            font=ctk.CTkFont(size=10),
            anchor="w",
            wraplength=160,
        )
        desc_lbl.grid(row=1, column=1, sticky="w")
        widgets.append(desc_lbl)

        for widget in [frame, *widgets]:
            widget.bind("<Button-1>", lambda event, k=key: self._on_nav_click(k))
            widget.bind("<Enter>",    lambda event, f=frame: self._on_nav_hover(f, True))
            widget.bind("<Leave>",    lambda event, f=frame: self._on_nav_hover(f, False))

        return frame

    def _build_main(self):
        self.main = ctk.CTkFrame(self, corner_radius=0, fg_color=CLR_SURFACE_ALT)
        self.main.grid(row=0, column=1, sticky="nsew")
        self.main.grid_columnconfigure(0, weight=1)
        self.main.grid_rowconfigure(1, weight=1)

        topbar = ctk.CTkFrame(self.main, fg_color=CLR_SURFACE, corner_radius=0, height=88)
        topbar.grid(row=0, column=0, sticky="ew")
        topbar.grid_propagate(False)
        topbar.grid_columnconfigure(0, weight=1)

        self.header_title = ctk.CTkLabel(
            topbar,
            text="Welcome to AgriPrice Dashboard",
            text_color=CLR_TEXT_PRIMARY,
            font=ctk.CTkFont(family="Georgia", size=20, weight="bold"),
            anchor="w",
        )
        self.header_title.grid(row=0, column=0, padx=28, pady=(16, 2), sticky="w")

        self.header_sub = ctk.CTkLabel(
            topbar,
            text="Data is collected by the separate Scraper Console. Run scraper_console.py to gather data.",
            text_color=CLR_TEXT_MUTED,
            font=ctk.CTkFont(size=12),
            anchor="w",
        )
        self.header_sub.grid(row=1, column=0, padx=28, pady=(0, 16), sticky="w")

        actions = ctk.CTkFrame(topbar, fg_color="transparent")
        actions.grid(row=0, column=1, rowspan=2, padx=20, sticky="e")

        self.rows_badge = self._make_badge(actions, "—", "Rows")
        self.cols_badge = self._make_badge(actions, "—", "Columns")
        self.rows_badge.pack(side="left", padx=(0, 8))
        self.cols_badge.pack(side="left")

        content = ctk.CTkFrame(self.main, corner_radius=0, fg_color=CLR_SURFACE_ALT)
        content.grid(row=1, column=0, sticky="nsew", padx=20, pady=20)
        content.grid_rowconfigure(0, weight=1)
        content.grid_columnconfigure(0, weight=1)

        card = ctk.CTkFrame(content, fg_color=CLR_SURFACE, corner_radius=10)
        card.grid(row=0, column=0, sticky="nsew")
        card.grid_rowconfigure(0, weight=1)
        card.grid_columnconfigure(0, weight=1)

        self.empty_state = ctk.CTkFrame(card, fg_color="transparent")
        self.empty_state.place(relx=0.5, rely=0.5, anchor="center")
        ctk.CTkLabel(
            self.empty_state,
            text="No data loaded yet.",
            text_color=CLR_TEXT_MUTED,
            font=ctk.CTkFont(size=16),
            justify="center",
        ).pack()
        ctk.CTkLabel(
            self.empty_state,
            text="Run scraper_console.py to collect data. The dashboard refreshes automatically every minute.",
            text_color=CLR_TEXT_MUTED,
            font=ctk.CTkFont(size=12),
            justify="center",
        ).pack(pady=(6, 0))

        self._build_table(card)

    def _build_table(self, parent):
        wrapper = ctk.CTkFrame(parent, fg_color="transparent")
        wrapper.pack(fill="both", expand=True, padx=4, pady=4)
        wrapper.grid_rowconfigure(0, weight=1)
        wrapper.grid_columnconfigure(0, weight=1)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure(
            "Pro.Treeview",
            background=CLR_SURFACE,
            foreground=CLR_TEXT_PRIMARY,
            rowheight=32,
            fieldbackground=CLR_SURFACE,
            borderwidth=0,
            relief="flat",
            font=("Helvetica", 11),
        )
        style.configure(
            "Pro.Treeview.Heading",
            background=CLR_SURFACE_ALT,
            foreground=CLR_TEXT_MUTED,
            font=("Helvetica", 10, "bold"),
            borderwidth=0,
            relief="flat",
            padding=(8, 6),
        )
        style.map(
            "Pro.Treeview",
            background=[("selected", CLR_ROW_SEL)],
            foreground=[("selected", CLR_TEXT_PRIMARY)],
        )
        style.layout("Pro.Treeview", [("Pro.Treeview.treearea", {"sticky": "nswe"})])

        self.tree = ttk.Treeview(wrapper, show="headings", style="Pro.Treeview", selectmode="browse")
        self.tree.grid(row=0, column=0, sticky="nsew")
        self.tree.tag_configure("odd",  background=CLR_ROW_ODD)
        self.tree.tag_configure("even", background=CLR_ROW_EVEN)

        vsb = ttk.Scrollbar(wrapper, orient="vertical",   command=self.tree.yview)
        vsb.grid(row=0, column=1, sticky="ns")
        hsb = ttk.Scrollbar(wrapper, orient="horizontal", command=self.tree.xview)
        hsb.grid(row=1, column=0, sticky="ew")
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

    def _make_badge(self, parent, value, label):
        frame = ctk.CTkFrame(
            parent,
            fg_color=CLR_SURFACE_ALT,
            corner_radius=8,
            border_width=1,
            border_color=CLR_BORDER,
        )
        value_label = ctk.CTkLabel(
            frame,
            text=value,
            text_color=CLR_ACCENT,
            font=ctk.CTkFont(size=20, weight="bold"),
        )
        value_label.pack(padx=16, pady=(8, 0))
        ctk.CTkLabel(
            frame,
            text=label,
            text_color=CLR_TEXT_MUTED,
            font=ctk.CTkFont(size=10),
        ).pack(padx=16, pady=(0, 8))
        frame._value_label = value_label
        return frame

    # -----------------------------------------------------------------
    # Navigation and data loading
    # -----------------------------------------------------------------
    def _on_nav_hover(self, frame, entering):
        if frame is not self.nav_buttons.get(self.active_key):
            frame.configure(fg_color="#243245" if entering else "transparent")

    def _on_nav_click(self, key):
        if self.active_key and self.active_key in self.nav_buttons:
            self.nav_buttons[self.active_key].configure(fg_color="transparent")
        self.active_key = key
        self.nav_buttons[key].configure(fg_color="#1E3A5F")
        self._load_active_dataset()

    def _load_active_dataset(self):
        if not self.active_key:
            return
        filepath, title, description, _ = self.datasets[self.active_key]
        self.load_data(filepath, title, description)

    def _auto_refresh(self):
        try:
            self._load_active_dataset()
        finally:
            self.after(AUTO_REFRESH_MS, self._auto_refresh)

    def load_data(self, filepath, title, description):
        self.header_title.configure(text=title)
        self.header_sub.configure(text=description)
        self.tree.delete(*self.tree.get_children())
        self.tree["columns"] = ()
        self.empty_state.place_forget()

        if not os.path.exists(filepath):
            self._show_notice(
                f"File not found:\n{filepath}\n\n"
                "Run scraper_console.py to collect data."
            )
            self._update_badges("—", "—")
            return

        try:
            df = pd.read_csv(filepath)
        except Exception as exc:
            self._show_notice(f"Failed to open CSV file:\n{exc}")
            self._update_badges("—", "—")
            return

        if df.empty:
            self._show_notice("The CSV file exists but contains no data yet.")
            self._update_badges("0", str(len(df.columns)))
            return

        if "Date" in df.columns:
            sort_dates = pd.to_datetime(df["Date"], errors="coerce")
            df = (
                df.assign(__sort_date=sort_dates)
                .sort_values("__sort_date", ascending=False)
                .drop(columns=["__sort_date"])
            )

        cols = list(df.columns)
        self.tree["columns"] = cols
        for col in cols:
            self.tree.heading(col, text=col, anchor="w")
            try:
                longest = int(df[col].astype(str).str.len().fillna(0).max())
            except Exception:
                longest = len(col)
            width = min(max(longest * 8, len(col) * 9, 90), 220)
            self.tree.column(col, width=width, anchor="w", minwidth=80)

        for i, (_, row) in enumerate(df.iterrows()):
            formatted = []
            for value in row.values:
                if pd.isna(value):
                    formatted.append("")
                elif isinstance(value, float):
                    formatted.append(f"{value:.4f}".rstrip("0").rstrip("."))
                else:
                    formatted.append(value)
            tag = "odd" if i % 2 == 0 else "even"
            self.tree.insert("", "end", values=formatted, tags=(tag,))

        self._update_badges(f"{len(df):,}", str(len(cols)))

    def _show_notice(self, message):
        self.tree["columns"] = ("message",)
        self.tree.heading("message", text="Notice", anchor="w")
        self.tree.column("message", width=900, anchor="w")
        self.tree.insert("", "end", values=(message,))

    def _update_badges(self, rows_value, cols_value):
        self.rows_badge._value_label.configure(text=rows_value)
        self.cols_badge._value_label.configure(text=cols_value)

    def _on_close(self):
        self.destroy()


if __name__ == "__main__":
    app = AgriDashboard()
    app.mainloop()
