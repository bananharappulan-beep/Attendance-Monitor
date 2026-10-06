import neon_sync
import pandas as pd


class METRIX:
    @staticmethod
    def get_metrix_dataframe():
        frames = {}
        skipped_branches = {branch.casefold() for branch in neon_sync.OUTPUT_SKIP_TABS}
        branches = [
            branch for branch in neon_sync.get_branches()
            if branch.casefold() not in skipped_branches
        ]
        matrices = neon_sync.get_saved_matrices(branches)
        for branch, matrix in matrices.items():
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