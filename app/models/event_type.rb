class EventType < ApplicationRecord
  has_many :bookings, dependent: :restrict_with_error

  validates :name, :description, presence: true
  validates :duration_minutes, numericality: { only_integer: true, greater_than: 0 }
end
