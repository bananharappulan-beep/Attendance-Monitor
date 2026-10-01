import sheets_sync
import pandas as pd


class METRIX:
    @staticmethod
    def get_metrix_dataframe():
        frames = {}
        skipped_branches = {branch.casefold() for branch in sheets_sync.OUTPUT_SKIP_TABS}
        for branch in sheets_sync.get_branches():
            if branch.casefold() in skipped_branches:
                continue
            matrix = sheets_sync.get_saved_matrix(branch)
            records = [
                {
                    "EMPLOYEE CODE": row.get("code", ""),
                    "EMPLOYEE NAME": row["name"],
                    **row["statuses"],
                }
                for row in matrix["rows"]
            ]
            columns = ["EMPLOYEE CODE", "EMPLOYEE NAME", *matrix["dates"]]
            frames[branch] = pd.DataFrame(records, columns=columns).fillna("")
        return frames


class INACTIVE:
    @staticmethod
    def get_inactive(start_date="29/9/2026", n_days=4):
        if n_days < 1:
            raise ValueError("n_days must be at least 1")

        parsed_start = sheets_sync.parse_date(start_date)
        if parsed_start is None:
            raise ValueError(f"Invalid start_date: {start_date!r}")
        start_date = parsed_start.isoformat()

        inactive_data = {}
        metrix_df = METRIX.get_metrix_dataframe()

        for branch, data in metrix_df.items():
            date_columns = [
                column for column in data.columns
                if column not in ("EMPLOYEE CODE", "EMPLOYEE NAME")
            ]
            if start_date not in data.columns:
                continue
            date_list = date_columns[date_columns.index(start_date):]

            has_data = data[date_list].fillna("").astype(str).apply(
                lambda column: column.str.strip().ne("").any()
            )
            available_dates = has_data[has_data].index.tolist()
            if len(available_dates) < n_days:
                continue

            cols_to_check = available_dates[-n_days:]

            mask = data[cols_to_check].fillna("").astype(str).apply(
                lambda column: column.str.strip().str.upper()
            ).eq("A").all(axis=1)
            inactive_data[branch] = data.loc[
                mask, ["EMPLOYEE CODE", "EMPLOYEE NAME"]
            ]

        return inactive_data

        




